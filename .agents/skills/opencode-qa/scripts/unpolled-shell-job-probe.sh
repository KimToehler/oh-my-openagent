#!/usr/bin/env bash
# unpolled-shell-job-probe.sh - prove live unpolled-shell-job cleanup after lean-ctx
# returns a reaped detached shell id.
#
# This drives a real isolated OpenCode server, local mock model, and local stdio MCP.
# It first observes warning for shell_a1b2c3d4e5f6, polls that id with a not-found reply,
# then waits past NUDGE_COOLDOWN_MS and registers shell_b1c2d3e4f5a6. A second warning
# must name only second id. This proves silence for first id is cleanup, not cooldown.
#
# Default run requires fixed dist. --negative-control temporarily removes source matcher,
# rebuilds dist, and must fail because second warning still names first id. Source and dist
# restore through EXIT cleanup; no package change remains after either mode.
#
# Usage:
#   bash unpolled-shell-job-probe.sh [--evidence-dir DIR] [--keep-sandbox]
#   bash unpolled-shell-job-probe.sh --negative-control [--evidence-dir DIR]
#   bash unpolled-shell-job-probe.sh --self-test
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
. "$SCRIPT_DIR/lib/common.sh"

EVIDENCE_DIR=""
KEEP_SANDBOX=0
SELF_TEST=0
NEGATIVE_CONTROL=0
FIRST_ID="shell_a1b2c3d4e5f6"
SECOND_ID="shell_b1c2d3e4f5a6"
COOLDOWN_SECONDS=65
SOURCE_TRACKER="$REPO_ROOT/packages/omo-opencode/src/hooks/unpolled-shell-job/tracker.ts"
DIST_INDEX="$REPO_ROOT/dist/index.js"
SOURCE_BACKUP=""
DIST_BACKUP=""

while [ $# -gt 0 ]; do
  case "$1" in
    # Resolved to an absolute path immediately. The script cd's into the sandbox project
    # later, so a relative dir would land inside the sandbox and be deleted with it,
    # leaving a green run with no artifacts to review.
    --evidence-dir) mkdir -p "$2" && EVIDENCE_DIR="$(cd "$2" && pwd)"; shift 2 ;;
    --keep-sandbox) KEEP_SANDBOX=1; shift ;;
    --self-test) SELF_TEST=1; shift ;;
    --negative-control) NEGATIVE_CONTROL=1; shift ;;
    *) oqa_log "unknown argument: $1"; exit 2 ;;
  esac
done

warning_count() { (grep -ao '<unpolled-background-shell-jobs>' "$1" 2>/dev/null || true) | wc -l | tr -d ' '; }
warning_has_id() {
  python3 - "$1" "$2" <<'PY'
from pathlib import Path
import sys
stream = Path(sys.argv[1]).read_text(errors="replace")
blocks = stream.split("<unpolled-background-shell-jobs>")[1:]
sys.exit(0 if any(sys.argv[2] in block.split("</unpolled-background-shell-jobs>", 1)[0] for block in blocks) else 1)
PY
}
wait_for_warning_count() {
  local file="$1" want="$2" deadline=$(( $(date +%s) + 45 )) count
  while [ "$(date +%s)" -lt "$deadline" ]; do
    count="$(warning_count "$file")"
    [ "$count" -ge "$want" ] && return 0
    sleep 1
  done
  return 1
}
copy_evidence() {
  [ -n "$EVIDENCE_DIR" ] || return 0
  mkdir -p "$EVIDENCE_DIR"
  for f in "$SANDBOX/serve.log" "$SSE_FILE" "$SANDBOX/mock-requests.log" "$SANDBOX/mock.out" "$SANDBOX/summary.txt"; do
    [ -f "$f" ] && cp "$f" "$EVIDENCE_DIR/$(basename "$f")"
  done
}
restore_negative_control() {
  [ -n "$SOURCE_BACKUP" ] && cp "$SOURCE_BACKUP" "$SOURCE_TRACKER"
  [ -n "$DIST_BACKUP" ] && cp "$DIST_BACKUP" "$DIST_INDEX"
}
cleanup_probe() {
  restore_negative_control
  copy_evidence
  oqa_cleanup
}

if [ "$SELF_TEST" = "1" ]; then
  fails=0
  no_warning='event: message\ndata: {"parts":[{"text":"normal turn"}]}'
  with_warning='event: message\ndata: {"parts":[{"text":"<unpolled-background-shell-jobs>\nshell_a1b2c3d4e5f6\n</unpolled-background-shell-jobs>"}]}'
  if warning_count <(printf '%b' "$no_warning") | grep -qx '0'; then oqa_pass "warning matcher rejects stream without warning"; else oqa_log "FAIL: matcher accepted stream without warning"; fails=$((fails+1)); fi
  if warning_count <(printf '%b' "$with_warning") | grep -qx '1' && warning_has_id <(printf '%b' "$with_warning") "$FIRST_ID"; then oqa_pass "warning matcher accepts warning with tracked id"; else oqa_log "FAIL: matcher missed warning or id"; fails=$((fails+1)); fi
  if warning_has_id <(printf '%b' "$with_warning") "$SECOND_ID"; then oqa_log "FAIL: id matcher accepted absent id"; fails=$((fails+1)); else oqa_pass "warning id matcher rejects absent id"; fi
  if [ "$fails" = 0 ]; then printf '\nSELF-TEST PASS\n'; exit 0; fi
  printf '\nSELF-TEST FAIL (%s)\n' "$fails" >&2; exit 1
fi

fails=0
if ! oqa_require opencode curl jq node sqlite3 bun; then oqa_log "FAIL: missing dependencies"; exit 1; fi
[ -f "$DIST_INDEX" ] || { oqa_log "FAIL: missing $DIST_INDEX"; exit 1; }
[ -f "$SOURCE_TRACKER" ] || { oqa_log "FAIL: missing $SOURCE_TRACKER"; exit 1; }

if [ "$NEGATIVE_CONTROL" = 1 ]; then
  SOURCE_BACKUP="$(mktemp -t oqa-tracker-source.XXXXXX)"
  DIST_BACKUP="$(mktemp -t oqa-tracker-dist.XXXXXX)"
  cp "$SOURCE_TRACKER" "$SOURCE_BACKUP"
  cp "$DIST_INDEX" "$DIST_BACKUP"
  # Neutralize the fix by making the matcher unable to match anything, rather than by
  # excising a comment block by its exact opening text. An anchor-based excision silently
  # no-ops when the comment is reworded: python raises, the heredoc dies, and because this
  # script runs under `set -uo pipefail` (no -e) the run CONTINUES against still-fixed code
  # and reports a green negative control. That happened, and it is the failure mode a
  # negative control exists to catch, so this must fail loudly instead.
  python3 - "$SOURCE_TRACKER" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
source = path.read_text()
call_site = ' || isNotFoundReply(output, polledJobId)'
if call_site not in source:
    sys.exit(f'negative control: call site not found in {path}; refusing to run a fake control')
patched = source.replace(call_site, '')
if patched == source:
    sys.exit('negative control: call-site removal changed nothing')
path.write_text(patched)
PY
  if [ $? -ne 0 ]; then
    oqa_log "FAIL: could not apply negative-control revert"
    restore_negative_control
    exit 1
  fi
  grep -q 'isNotFoundReply(output, polledJobId)' "$SOURCE_TRACKER" && {
    oqa_log "FAIL: negative-control revert did not remove the call site"
    restore_negative_control
    exit 1
  }
  if ! bun run build >"$(dirname "$DIST_INDEX")/negative-control-build.log" 2>&1; then
    cat "$(dirname "$DIST_INDEX")/negative-control-build.log" >&2
    oqa_log "FAIL: negative-control build failed"
    restore_negative_control
    exit 1
  fi
  # The probe drives dist/, not src/. A build that silently reused a cached bundle would
  # run the FIXED code under a control that claims to be broken.
  if cmp -s "$DIST_BACKUP" "$DIST_INDEX"; then
    oqa_log "FAIL: negative-control dist is byte-identical to the fixed dist; the revert did not reach the bundle"
    restore_negative_control
    exit 1
  fi
fi

oqa_mk_isolated_xdg || { oqa_log "FAIL: could not create sandbox"; restore_negative_control; exit 1; }
SANDBOX="$OQA_XDG_ROOT"
[ "$KEEP_SANDBOX" = 1 ] && OQA_TMPDIRS=()
trap cleanup_probe EXIT

mkdir -p "$OQA_PROJ/.omo" "$HOME/.omo" "$XDG_CONFIG_HOME/opencode"
MOCK_PORT="$(oqa_free_port)"
MCP_SERVER="$SANDBOX/ctx-shell-mcp.mjs"
cat >"$MCP_SERVER" <<'MJS'
import { createInterface } from 'node:readline'
const first = 'shell_a1b2c3d4e5f6'
const second = 'shell_b1c2d3e4f5a6'
function reply(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`) }
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') return reply(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } })
  if (request.method === 'notifications/initialized') return
  if (request.method === 'tools/list') return reply(request.id, { tools: [{ name: 'ctx_shell', description: 'QA shell fixture', inputSchema: { type: 'object', properties: { run_in_background: { type: 'boolean' }, background_action: { type: 'string' }, job_id: { type: 'string' }, command: { type: 'string' } } } }] })
  if (request.method === 'tools/call') {
    const args = request.params.arguments ?? {}
    const text = args.background_action === 'status' ? `[background:${args.job_id} not found or expired]` : `[background:${args.command === 'second' ? second : first} started]`
    return reply(request.id, { content: [{ type: 'text', text }] })
  }
  reply(request.id, {})
})
MJS

cat >"$SANDBOX/script.json" <<JSON
[
  {"tool":"probe_ctx_shell","when":"START_FIRST","unless":"shell_a1b2c3d4e5f6","args":{"run_in_background":true,"command":"first"}},
  {"text":"first detached job created"},
  {"tool":"probe_ctx_shell","when":"<unpolled-background-shell-jobs>","unless":"not found or expired","args":{"background_action":"status","job_id":"$FIRST_ID"}},
  {"text":"first reaped job polled"},
  {"tool":"probe_ctx_shell","when":"START_SECOND","unless":"shell_b1c2d3e4f5a6","args":{"run_in_background":true,"command":"second"}},
  {"text":"second detached job created"},
  {"text":"done"}
]
JSON
MOCK_PORT="$MOCK_PORT" MOCK_SCRIPT_FILE="$SANDBOX/script.json" MOCK_LOG="$SANDBOX/mock-requests.log" node "$SCRIPT_DIR/lib/mock-model.mjs" >"$SANDBOX/mock.out" 2>&1 &
MOCK_PID=$!
OQA_CURL_PIDS+=("$MOCK_PID")
for _ in $(seq 1 50); do grep -q MOCK_LISTENING "$SANDBOX/mock.out" && break; sleep 0.1; done
grep -q MOCK_LISTENING "$SANDBOX/mock.out" || { oqa_log "FAIL: mock did not start"; exit 1; }

cat >"$XDG_CONFIG_HOME/opencode/opencode.json" <<JSON
{"plugin":["file://$REPO_ROOT"],"provider":{"mockprov":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"http://127.0.0.1:$MOCK_PORT/v1","apiKey":"not-needed"},"models":{"mock-model":{"name":"mock-model"}}}},"model":"mockprov/mock-model","mcp":{"probe":{"type":"local","command":["node","$MCP_SERVER"],"enabled":true}}}
JSON
AGENTS=''
for agent in sisyphus hephaestus prometheus oracle librarian explore multimodal-looker metis momus atlas sisyphus-junior; do AGENTS="$AGENTS\"$agent\":{\"model\":\"mockprov/mock-model\"},"; done
CATEGORIES=''
for category in visual-engineering ultrabrain deep artistry quick unspecified-low unspecified-high writing; do CATEGORIES="$CATEGORIES\"$category\":{\"model\":\"mockprov/mock-model\"},"; done
cat >"$OQA_PROJ/.omo/omo.jsonc" <<JSON
{"[opencode]":{"agents":{${AGENTS%,}},"categories":{${CATEGORIES%,}}}}
JSON
cp "$OQA_PROJ/.omo/omo.jsonc" "$HOME/.omo/omo.jsonc"

cd "$OQA_PROJ" || exit 1
PORT="$(oqa_free_port)"; PASS="oqa-${RANDOM}${RANDOM}"
OPENCODE_SERVER_PASSWORD="$PASS" opencode serve --port "$PORT" --hostname 127.0.0.1 >"$SANDBOX/serve.log" 2>&1 &
OQA_SERVER_PID=$!; disown "$OQA_SERVER_PID" 2>/dev/null || true
OQA_SERVER_URL="http://127.0.0.1:$PORT"; AUTH="opencode:$PASS"
oqa_log "step: waiting for server health"
oqa_wait_http "$OQA_SERVER_URL/global/health" "$AUTH" 30 || { oqa_log "FAIL: server did not start"; cat "$SANDBOX/serve.log" >&2; exit 1; }
oqa_log "step: server ready, creating session"

SSE_FILE="$SANDBOX/events.sse"
curl -s -N -u "$AUTH" "$OQA_SERVER_URL/event" >"$SSE_FILE" 2>/dev/null & OQA_CURL_PIDS+=($!)
sleep 1
# Bounded with -m. Session creation blocks on MCP init, and an MCP that never settles
# would hang this command substitution forever with no deadline to escape through.
# Every other wait in this script is bounded; a bare curl here is the one hole that
# turns a stalled dependency into an unkillable run rather than a FAIL line.
SESSION_JSON="$(curl -s -m 60 -u "$AUTH" -X POST "$OQA_SERVER_URL/session" -H 'Content-Type: application/json' -d "{\"directory\":\"$OQA_PROJ\"}")"
SESSION_ID="$(printf '%s' "$SESSION_JSON" | jq -r '.id // empty')"
[ -n "$SESSION_ID" ] || { oqa_log "FAIL: no session id (curl may have timed out): $SESSION_JSON"; exit 1; }
oqa_log "step: session created, prompting"
printf 'SESSION_ID=%s\n' "$SESSION_ID" | tee "$SANDBOX/summary.txt"
REAL_DB="$(oqa_db_path)"
if sqlite3 "$REAL_DB" "SELECT 1 FROM session WHERE id=$(oqa_sql_escape "$SESSION_ID");" 2>/dev/null | grep -q 1; then oqa_log "FAIL: session leaked into real DB"; exit 1; else oqa_pass "session identity absent from real DB"; fi

curl -s -m 180 -u "$AUTH" -X POST "$OQA_SERVER_URL/session/$SESSION_ID/message" -H 'Content-Type: application/json' -d '{"parts":[{"type":"text","text":"START_FIRST"}]}' >"$SANDBOX/first-prompt.json" 2>&1 & OQA_CURL_PIDS+=($!)
if wait_for_warning_count "$SSE_FILE" 1 && warning_has_id "$SSE_FILE" "$FIRST_ID"; then oqa_pass "first idle warning fired for registered first job"; else oqa_log "FAIL: first warning missing first job"; fails=$((fails+1)); fi
if grep -qF "probe_ctx_shell" "$SSE_FILE"; then oqa_pass "observed tool name ends in ctx_shell"; else oqa_log "FAIL: no observed probe_ctx_shell tool event"; fails=$((fails+1)); fi
if grep -qF "[background:$FIRST_ID not found or expired]" "$SSE_FILE"; then oqa_pass "status poll returned not-found fixture for exact first id"; else oqa_log "FAIL: not-found status result missing"; fails=$((fails+1)); fi

sleep "$COOLDOWN_SECONDS"
curl -s -m 180 -u "$AUTH" -X POST "$OQA_SERVER_URL/session/$SESSION_ID/message" -H 'Content-Type: application/json' -d '{"parts":[{"type":"text","text":"START_SECOND"}]}' >"$SANDBOX/second-prompt.json" 2>&1 & OQA_CURL_PIDS+=($!)
if wait_for_warning_count "$SSE_FILE" 2 && warning_has_id "$SSE_FILE" "$SECOND_ID"; then oqa_pass "post-cooldown warning fired for second job"; else oqa_log "FAIL: second warning missing second job"; fails=$((fails+1)); fi
if warning_has_id <(grep -azo '<unpolled-background-shell-jobs>[^<]*' "$SSE_FILE" | tr '\0' '\n' | tail -1) "$FIRST_ID"; then oqa_log "FAIL: second warning retained first reaped job"; fails=$((fails+1)); else oqa_pass "second warning excludes first reaped job"; fi

FIRST_WARNING=0; SECOND_WARNING=0; REGISTERED=0
warning_has_id "$SSE_FILE" "$FIRST_ID" && FIRST_WARNING=1
warning_has_id "$SSE_FILE" "$SECOND_ID" && SECOND_WARNING=1
grep -qF "probe_ctx_shell" "$SSE_FILE" && REGISTERED=1
printf 'REGISTERED=%s FIRST_WARNING=%s SECOND_WARNING=%s SESSION_ID=%s NEGATIVE_CONTROL=%s\n' "$REGISTERED" "$FIRST_WARNING" "$SECOND_WARNING" "$SESSION_ID" "$NEGATIVE_CONTROL" | tee -a "$SANDBOX/summary.txt"
if [ "$NEGATIVE_CONTROL" = 1 ]; then
  if [ "$fails" -gt 0 ]; then printf '\nNEGATIVE CONTROL PASS: probe failed against broken tracker\n'; exit 0; fi
  printf '\nNEGATIVE CONTROL FAIL: probe passed against broken tracker\n' >&2; exit 1
fi
if [ "$fails" = 0 ]; then printf '\nUNPOLLED SHELL JOB PROBE PASS\n'; exit 0; fi
printf '\nUNPOLLED SHELL JOB PROBE FAIL (%s)\n' "$fails" >&2; exit 1
