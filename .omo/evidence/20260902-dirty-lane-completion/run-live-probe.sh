#!/usr/bin/env bash
# Real OpenCode server proof. Evidence-only: no product source edits.
set -Eeuo pipefail

EVIDENCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE="/Users/tim/git/oh-my-openagent/.worktrees/bg-lane-fixes"
DIST="$WORKTREE/dist/index.js"
HOST_DB="$(opencode db path)"
HOST_BEFORE="$(sqlite3 "$HOST_DB" 'SELECT count(*) FROM session')"
printf '%s\n' "$HOST_BEFORE" > "$EVIDENCE_DIR/01-host-session-count-before.txt"
HOST_AFTER=""
FAILURE=""
ACTIVE_PIDS=()

record_exit() {
  status=$?
  for pid in "${ACTIVE_PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${ACTIVE_PIDS[@]:-}"; do
    wait "$pid" 2>/dev/null || true
  done
  HOST_AFTER="$(sqlite3 "$HOST_DB" 'SELECT count(*) FROM session')"
  printf '%s\n' "$HOST_AFTER" > "$EVIDENCE_DIR/19-host-session-count-after.txt"
  printf 'host_before=%s\nhost_after=%s\nexit_status=%s\n' "$HOST_BEFORE" "$HOST_AFTER" "$status" > "$EVIDENCE_DIR/90-cleanup-receipt.txt"
  if [ "$HOST_BEFORE" != "$HOST_AFTER" ]; then
    printf 'ISOLATION BREACH: host session count %s -> %s\n' "$HOST_BEFORE" "$HOST_AFTER" >&2
    exit 1
  fi
  exit "$status"
}
trap record_exit EXIT
fail() { FAILURE="$1"; printf 'FAIL %s\n' "$FAILURE" >&2; exit 1; }
free_port() { python3 - <<'PY'
import socket
s=socket.socket(); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1]); s.close()
PY
}
wait_file() { local file=$1 label=$2; for _ in $(seq 1 250); do [ -f "$file" ] && return 0; sleep .1; done; fail "deadline: $label"; }
wait_http() { local url=$1 label=$2 auth=${3:-}; for _ in $(seq 1 250); do curl -fsS ${auth:+-u "$auth"} "$url" >/dev/null && return 0; sleep .1; done; fail "deadline: $label ($url)"; }
wait_child() { local db=$1 parent=$2 out=$3; local child; for _ in $(seq 1 250); do child="$(sqlite3 "$db" "SELECT id FROM session WHERE parent_id='$parent' ORDER BY time_created DESC LIMIT 1")"; if [ -n "$child" ]; then printf '%s\n' "$child" > "$out"; return 0; fi; sleep .1; done; fail "deadline: real server-minted child DB row for $parent"; }

[ -f "$DIST" ] || fail "missing built plugin $DIST"
source "$WORKTREE/script/agent/qa-sandbox.sh" > "$EVIDENCE_DIR/02-qa-sandbox.txt"
cd "$OMO_QA_PROJ"
printf 'HOME=%s\nPWD=%s\nOMO_QA_PROJ=%s\n' "$HOME" "$PWD" "$OMO_QA_PROJ" > "$EVIDENCE_DIR/03-isolation-paths.txt"
case "$HOME:$PWD" in "$OMO_QA_ROOT"/*:"$OMO_QA_ROOT"/*) ;; *) fail 'HOME/PWD outside qa sandbox';; esac
mkdir -p "$XDG_CONFIG_HOME/opencode" "$HOME/.omo"
printf '{}\n' > "$HOME/.omo/omo.jsonc"

cat > "$EVIDENCE_DIR/fake-dirty-lane-model.mjs" <<'NODE'
import http from 'node:http'
import fs from 'node:fs'
const port=Number(process.env.FAKE_PORT), marker=process.env.MARKER, ready=process.env.READY, release=process.env.RELEASE, log=process.env.LOG
let sequence=0
const note=(text)=>fs.appendFileSync(log, `${new Date().toISOString()} ${text}\n`)
const usage={input_tokens:1,output_tokens:1,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}
const finish=(res, events)=>{res.writeHead(200, {'content-type':'text/event-stream'}); for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`); res.end('data: [DONE]\n\n')}
const text=(value)=>{const id=`m${sequence}`; return [{type:'response.created',response:{id:`r${sequence}`,created_at:Math.floor(Date.now()/1000),model:'gpt-fake'}},{type:'response.output_item.added',output_index:0,item:{type:'message',id}},{type:'response.output_text.delta',item_id:id,output_index:0,delta:value},{type:'response.output_item.done',output_index:0,item:{type:'message',id}},{type:'response.completed',response:{usage}}]}
const task=()=>{const id=`fc${sequence}`, args={description:`${marker}_CHILD`,prompt:`${marker}_CHILD`,subagent_type:'explore',run_in_background:true,load_skills:[]}, encoded=JSON.stringify(args); return [{type:'response.created',response:{id:`r${sequence}`,created_at:Math.floor(Date.now()/1000),model:'gpt-fake'}},{type:'response.output_item.added',output_index:0,item:{type:'function_call',id,call_id:`call${sequence}`,name:'task',arguments:''}},{type:'response.function_call_arguments.delta',item_id:id,output_index:0,delta:encoded},{type:'response.output_item.done',output_index:0,item:{type:'function_call',id,call_id:`call${sequence}`,name:'task',arguments:encoded,status:'completed'}},{type:'response.completed',response:{usage}}]}
http.createServer(async (req,res)=>{if(req.url==='/health'){res.end('ok');return}let raw='';for await(const chunk of req)raw+=chunk;sequence++;let body={};try{body=JSON.parse(raw)}catch{}const input=JSON.stringify(body.input??body.messages??body);if(input.includes(`${marker}_CHILD`)){note('child-inflight');fs.writeFileSync(ready,'ready');const timer=setInterval(()=>{},1000);while(!fs.existsSync(release))await new Promise(resolve=>setTimeout(resolve,50));clearInterval(timer);note('child-release');finish(res,text(`${marker}_CHILD_DONE`));return}if(input.includes(marker)&&!input.includes('function_call_output')&&!input.includes('tool_result')){note('parent-task');finish(res,task());return}if(input.includes('[BACKGROUND TASK')){note('parent-wake');finish(res,text(`${marker}_WAKE`));return}note('default');finish(res,text(`${marker}_OK`))}).listen(port,'127.0.0.1',()=>note(`started port=${port}`))
NODE

run_scenario() {
  local name=$1 post_launch=$2
  local marker="DIRTY_LANE_${name}_$(date +%s%N)"
  local root="$OMO_QA_PROJ/$name" fake_port server_port fake_pid server_pid sse_pid db parent child
  root="$root"; mkdir -p "$root"; git -C "$root" init -q
  printf 'baseline dirty before child launch\n' > "$root/${name}-baseline-before-launch.marker"
  git -C "$root" status --porcelain -z > "$EVIDENCE_DIR/${name}-04-status-before.z"
  git -C "$root" status --porcelain -z | tr '\0' '\n' > "$EVIDENCE_DIR/${name}-04-status-before.txt"
  fake_port="$(free_port)"; server_port="$(free_port)"
  local ready="$EVIDENCE_DIR/${name}-ready.marker" release="$EVIDENCE_DIR/${name}-release.marker" fake_log="$EVIDENCE_DIR/${name}-05-fake.log" fake_out="$EVIDENCE_DIR/${name}-05-fake-terminal.txt" server_log="$EVIDENCE_DIR/${name}-07-server-terminal.txt" sse="$EVIDENCE_DIR/${name}-06-sse.txt"
  rm -f "$ready" "$release"
  FAKE_PORT="$fake_port" MARKER="$marker" READY="$ready" RELEASE="$release" LOG="$fake_log" bun "$EVIDENCE_DIR/fake-dirty-lane-model.mjs" > "$fake_out" 2>&1 & fake_pid=$!; ACTIVE_PIDS+=("$fake_pid")
  wait_http "http://127.0.0.1:$fake_port/health" "$name fake model health"
  cat > "$XDG_CONFIG_HOME/opencode/opencode.jsonc" <<JSON
{"plugin":["file://${DIST}"],"model":"openai/gpt-fake","provider":{"openai":{"options":{"apiKey":"fake","baseURL":"http://127.0.0.1:${fake_port}/v1","timeout":30000},"models":{"gpt-fake":{"tool_call":true,"limit":{"context":200000,"output":8192}}}}},"permission":{"task":"allow","background_output":"allow"}}
JSON
  OPENCODE_SERVER_PASSWORD=dirty-lane-pass opencode serve --hostname 127.0.0.1 --port "$server_port" > "$server_log" 2>&1 & server_pid=$!; ACTIVE_PIDS+=("$server_pid")
  wait_http "http://127.0.0.1:$server_port/global/health" "$name OpenCode health" 'opencode:dirty-lane-pass'
  curl -NsS -u opencode:dirty-lane-pass "http://127.0.0.1:$server_port/event" > "$sse" & sse_pid=$!; ACTIVE_PIDS+=("$sse_pid")
  local encoded; encoded="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$root")"
  parent="$(curl -fsS -u opencode:dirty-lane-pass -X POST "http://127.0.0.1:$server_port/session?directory=$encoded" -H content-type:application/json -d "{\"title\":\"$name\"}" | jq -r .id)"
  printf '%s\n' "$parent" > "$EVIDENCE_DIR/${name}-09-parent-session.txt"
  curl -fsS -u opencode:dirty-lane-pass -X POST "http://127.0.0.1:$server_port/session/$parent/prompt_async?directory=$encoded" -H content-type:application/json -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$marker\"}]}" >/dev/null
  wait_file "$ready" "$name child fake request inflight"
  db="$XDG_DATA_HOME/opencode/opencode.db"; wait_child "$db" "$parent" "$EVIDENCE_DIR/${name}-10-child-session.txt"; child="$(cat "$EVIDENCE_DIR/${name}-10-child-session.txt")"
  if [ "$post_launch" = yes ]; then printf 'new dirty after child launch\n' > "$root/${name}-new-after-launch.marker"; fi
  git -C "$root" status --porcelain -z > "$EVIDENCE_DIR/${name}-11-status-completion.z"
  git -C "$root" status --porcelain -z | tr '\0' '\n' > "$EVIDENCE_DIR/${name}-11-status-completion.txt"
  printf 'release\n' > "$release"
  local parts="$EVIDENCE_DIR/${name}-12-parent-parts.txt"
  for _ in $(seq 1 300); do sqlite3 "$db" "SELECT data FROM part WHERE message_id IN (SELECT id FROM message WHERE session_id='$parent')" > "$parts"; grep -F '[BACKGROUND TASK COMPLETED]' "$parts" >/dev/null && break; sleep .1; done
  grep -F '[BACKGROUND TASK COMPLETED]' "$parts" > "$EVIDENCE_DIR/${name}-13-completion.txt" || fail "$name child did not complete into parent notification"
  grep -F "$child" "$EVIDENCE_DIR/${name}-13-completion.txt" >/dev/null || fail "$name notification lacks real child session"
  if [ "$post_launch" = yes ]; then
    grep -F 'completed with 1 uncommitted file' "$EVIDENCE_DIR/${name}-13-completion.txt" > "$EVIDENCE_DIR/${name}-14-exact-count.txt" || fail "$name missing exact singular dirty annotation"
    ! grep -F 'completed with 2 uncommitted files' "$EVIDENCE_DIR/${name}-13-completion.txt" || fail "$name incorrectly counted baseline plus new path"
    grep -F "${name}-baseline-before-launch.marker" "$EVIDENCE_DIR/${name}-11-status-completion.txt" > "$EVIDENCE_DIR/${name}-15-baseline-proof.txt"
    grep -F "${name}-new-after-launch.marker" "$EVIDENCE_DIR/${name}-11-status-completion.txt" > "$EVIDENCE_DIR/${name}-16-new-proof.txt"
  else
    ! grep -F 'uncommitted file' "$EVIDENCE_DIR/${name}-13-completion.txt" || fail "$name emitted dirty annotation without new post-launch file"
    grep -F "${name}-baseline-before-launch.marker" "$EVIDENCE_DIR/${name}-11-status-completion.txt" > "$EVIDENCE_DIR/${name}-15-baseline-proof.txt"
  fi
  kill "$sse_pid" "$server_pid" "$fake_pid" 2>/dev/null || true
  wait "$sse_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; wait "$fake_pid" 2>/dev/null || true
  printf 'fake_pid=%s server_pid=%s sse_pid=%s cleaned=yes\n' "$fake_pid" "$server_pid" "$sse_pid" > "$EVIDENCE_DIR/${name}-91-process-cleanup.txt"
}

run_scenario FIXED yes
run_scenario NEGATIVE no
printf 'PASS: FIXED exact 1-file annotation; NEGATIVE omitted annotation; host DB unchanged; processes cleaned.\n' | tee "$EVIDENCE_DIR/20-verdict.txt"
