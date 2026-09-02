#!/usr/bin/env bash
# Proves BackgroundManager.resume() dispatches the continuation prompt for an orphan
# that was killed MID-TURN (its transcript ends in an unterminated assistant turn).
#
# WHY A SEPARATE PROBE: resume-adopt-restart-probe.sh drives the resume tool with
# run_in_background=false, which routes to executeSyncContinuation ->
# adoptRunningSession (sync-continuation.ts) and NEVER calls manager.resume().
# Only run_in_background=true reaches executeBackgroundContinuation -> manager.resume()
# (background-continuation.ts:30), which is the code path under test here.
#
# ORACLE: a coarse message-count delta is NOT sufficient - unrelated paths such as
# model-suggestion-retry also append messages. This probe asserts on a signal unique
# to the path under test: a prompt-async-gate dispatch whose source is
# "background-agent-resume" for the mid-turn child session, read from the plugin log
# that is redirected into the sandbox via TMPDIR.
#
# NEGATIVE CONTROL: run with --expect-blocked against a build WITHOUT the
# checkToolState:false adopt-path fix. The probe then requires the gate to SKIP the
# dispatch ("skipped because latest assistant is still active"). A probe that has
# never been observed red is not evidence.
#
# AGENT IDENTITY: the probe also asserts the adopted task carries the agent the child
# actually ran under ("explore"), not the fabricated "continue" that made adopted tasks
# die with `Agent "continue" not found`. Its negative control is
# --expect-fabricated-agent, run against a build that still fabricates the name.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/common.sh"
SELF_TEST=0; EVIDENCE_DIR=""; EXPECT_BLOCKED=0; EXPECT_FABRICATED_AGENT=0
while [ $# -gt 0 ]; do case "$1" in
  --self-test) SELF_TEST=1;;
  --expect-blocked) EXPECT_BLOCKED=1;;
  --expect-fabricated-agent) EXPECT_FABRICATED_AGENT=1;;
  --evidence-dir) EVIDENCE_DIR="${2:?--evidence-dir needs DIR}"; shift;;
  -h|--help) echo "Usage: $0 [--self-test] [--expect-blocked] [--expect-fabricated-agent] --evidence-dir DIR"; exit 0;;
  *) echo "unknown option: $1" >&2; exit 2;; esac; shift; done
[ -n "$EVIDENCE_DIR" ] || EVIDENCE_DIR="${TMPDIR:-/tmp}/resume-adopt-midturn-$(date +%s)"; mkdir -p "$EVIDENCE_DIR"

REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
[ -f "$REPO_ROOT/dist/index.js" ] || { echo "dist/index.js missing - run bun run build first" >&2; exit 1; }
HOST_DB="$(opencode db path)"; BEFORE="$(sqlite3 "$HOST_DB" 'SELECT count(*) FROM session')"
printf '%s\n' "$BEFORE" > "$EVIDENCE_DIR/01-host-session-count-before.txt"

FAKE_PID=""; SERVER_PID=""; SERVER_PORT=""; FAKE_PORT=""
cleanup() {
  for pid in "$SERVER_PID" "$FAKE_PID"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  for pid in "$SERVER_PID" "$FAKE_PID"; do [ -n "$pid" ] && wait "$pid" 2>/dev/null || true; done
  { printf 'server_pid=%s alive=' "$SERVER_PID"; kill -0 "$SERVER_PID" 2>/dev/null && printf yes || printf no
    printf '\nfake_pid=%s alive=' "$FAKE_PID"; kill -0 "$FAKE_PID" 2>/dev/null && printf yes || printf no
    printf '\n'; } > "$EVIDENCE_DIR/90-cleanup-receipt.txt"
  # bash keeps only the LAST EXIT trap, so registering this one replaced common.sh's
  # `trap oqa_cleanup EXIT`. Call it explicitly or the ~215MB XDG sandbox is never removed.
  oqa_cleanup
}
trap cleanup EXIT

oqa_mk_isolated_xdg
OQA_PROJ="$(node -e 'const {realpathSync}=require("fs");console.log(realpathSync(process.argv[1]))' "$OQA_PROJ")"
# Redirect the plugin logger (os.tmpdir()/oh-my-opencode.log) into the sandbox so the
# oracle reads ONLY this run, never a shared host log polluted by other sessions.
SANDBOX_TMP="$XDG_DATA_HOME/tmp"; mkdir -p "$SANDBOX_TMP"; export TMPDIR="$SANDBOX_TMP"
PLUGIN_LOG="$SANDBOX_TMP/oh-my-opencode.log"
printf '%s\n' "$PLUGIN_LOG" > "$EVIDENCE_DIR/02-plugin-log-path.txt"

FAKE_PORT="$(oqa_free_port)"
FAKE_LLM_LOG="$EVIDENCE_DIR/03-fake-openai.log" FAKE_OPENAI_PORT="$FAKE_PORT" \
  MIDTURN_ADOPT_CHILD_ID_FILE="$EVIDENCE_DIR/.midturn-child-id" \
  bun run --bun "$SCRIPT_DIR/lib/fake-openai-server.mjs" > "$EVIDENCE_DIR/03-fake-openai.stdout" 2>&1 & FAKE_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$FAKE_PORT/health" >/dev/null && break; sleep .2; done
curl -sf "http://127.0.0.1:$FAKE_PORT/health" >/dev/null || { echo 'fake LLM unavailable' >&2; exit 1; }

mkdir -p "$XDG_CONFIG_HOME/opencode"
cat > "$XDG_CONFIG_HOME/opencode/opencode.jsonc" <<JSONC
{"plugin":["file://${REPO_ROOT}/dist/index.js"],"model":"openai/gpt-fake","provider":{"openai":{"options":{"apiKey":"fake-key","baseURL":"http://127.0.0.1:${FAKE_PORT}/v1","timeout":30000},"models":{"gpt-fake":{"tool_call":true,"limit":{"context":200000,"output":8192}}}}},"permission":{"task":"allow","background_output":"allow"}}
JSONC

start_server() { SERVER_PORT="$(oqa_free_port)"; OPENCODE_SERVER_PASSWORD="probe-pass" opencode serve --hostname 127.0.0.1 --port "$SERVER_PORT" > "$EVIDENCE_DIR/04-opencode-serve-${1}.log" 2>&1 & SERVER_PID=$!; for _ in $(seq 1 100); do curl -sf -u opencode:probe-pass "http://127.0.0.1:$SERVER_PORT/global/health" > "$EVIDENCE_DIR/04-health-${1}.json" && return; sleep .2; done; return 1; }
enc_dir() { python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$OQA_PROJ"; }
new_session() { curl -sf -u opencode:probe-pass -X POST "http://127.0.0.1:$SERVER_PORT/session?directory=$(enc_dir)" -H content-type:application/json -d '{"title":"resume adopt midturn"}' | jq -r .id; }
prompt() { curl -sf -u opencode:probe-pass -X POST "http://127.0.0.1:$SERVER_PORT/session/$1/prompt_async?directory=$(enc_dir)" -H content-type:application/json -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$2\"}]}" >/dev/null; }

DB="$XDG_DATA_HOME/opencode/opencode.db"
start_server first
PARENT="$(new_session)"; prompt "$PARENT" 'SPLIT_CHILD_TASK: restart-midturn'

# Wait for the real child session, sourced from the sandbox DB (never regex-matched
# out of mock response text, which would match a canned fixture id).
for _ in $(seq 1 150); do
  MIDCHILD="$(sqlite3 "$DB" "SELECT s.id FROM session s JOIN message m ON m.session_id=s.id JOIN part p ON p.message_id=m.id WHERE json_extract(p.data,'\$.text') LIKE '%SPLIT_CHILD_TASK: hang-midturn%' ORDER BY s.time_created DESC LIMIT 1")"
  [ -n "$MIDCHILD" ] && break; sleep .2
done
[[ "$MIDCHILD" =~ ^ses_[A-Za-z0-9]{20,}$ ]] || { echo "midturn child id not found or malformed: '$MIDCHILD'" >&2; exit 1; }
sqlite3 "$DB" "SELECT id FROM session WHERE id='$MIDCHILD'" | grep -Fx "$MIDCHILD" > "$EVIDENCE_DIR/05-midturn-child-row.txt" || { echo "child id does not resolve to a real session row" >&2; exit 1; }
printf '%s\n' "$MIDCHILD" > "$EVIDENCE_DIR/05-midturn-child-id.txt"
printf '%s\n' "$MIDCHILD" > "$EVIDENCE_DIR/.midturn-child-id"

# Wait until the child is genuinely mid-turn: its hanging bash tool call is running.
for _ in $(seq 1 150); do
  RUNNING="$(sqlite3 "$DB" "SELECT count(*) FROM part WHERE message_id IN (SELECT id FROM message WHERE session_id='$MIDCHILD') AND data LIKE '%hang so the restart kills%' AND data LIKE '%\"status\":\"running\"%'")"
  [ "${RUNNING:-0}" -gt 0 ] && break; sleep .2
done
[ "${RUNNING:-0}" -gt 0 ] || { echo 'midturn child never entered a running tool call' >&2; exit 1; }
MIDPRE="$(sqlite3 "$DB" "SELECT count(*) FROM message WHERE session_id='$MIDCHILD'")"
sqlite3 "$DB" "SELECT json_extract(data,'\$.type'), substr(data,1,140) FROM part WHERE message_id IN (SELECT id FROM message WHERE session_id='$MIDCHILD') ORDER BY id" > "$EVIDENCE_DIR/06-pre-kill-parts.txt"

# SIGKILL mid-turn so the server cannot finalize the assistant turn on the way out.
kill -9 "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true
printf 'server-one-sigkilled=%s\n' "$SERVER_PID" > "$EVIDENCE_DIR/07-server-sigkilled.txt"; SERVER_PID=""

UNTERM="$(sqlite3 "$DB" "SELECT count(*) FROM message WHERE session_id='$MIDCHILD' AND json_extract(data,'\$.role')='assistant' AND json_extract(data,'\$.time.completed') IS NULL")"
printf 'unterminated_assistant_turns=%s\n' "$UNTERM" > "$EVIDENCE_DIR/08-unterminated-turn.txt"
[ "${UNTERM:-0}" -gt 0 ] || { echo 'PRECONDITION FAILED: transcript has no unterminated assistant turn; the scenario under test was never created' >&2; exit 1; }

# Mark the log boundary so the oracle only reads post-restart dispatch decisions.
LOG_OFFSET=0; [ -f "$PLUGIN_LOG" ] && LOG_OFFSET="$(wc -l < "$PLUGIN_LOG" | tr -d ' ')"
printf 'log_lines_before_resume=%s\n' "$LOG_OFFSET" > "$EVIDENCE_DIR/09-log-offset.txt"

start_server second
printf 'server-two-started=%s\n' "$SERVER_PID" > "$EVIDENCE_DIR/10-server-restarted.txt"
sqlite3 "$DB" "SELECT id FROM session WHERE id='$MIDCHILD'" | grep -Fx "$MIDCHILD" > "$EVIDENCE_DIR/11-child-survived-restart.txt"

RESUMER="$(new_session)"; prompt "$RESUMER" "SPLIT_MIDTURN_ADOPT: $MIDCHILD"; sleep 8
MIDPOST="$(sqlite3 "$DB" "SELECT count(*) FROM message WHERE session_id='$MIDCHILD'")"

# ---- ORACLE: assert on signals unique to manager.resume(), not on row counts ----
tail -n "+$((LOG_OFFSET + 1))" "$PLUGIN_LOG" 2>/dev/null > "$EVIDENCE_DIR/12-plugin-log-after-resume.txt"
grep -F "$MIDCHILD" "$EVIDENCE_DIR/12-plugin-log-after-resume.txt" > "$EVIDENCE_DIR/13-child-log-lines.txt" 2>/dev/null
RESUME_DISPATCHED="$(grep -c "promptAsync dispatched.*\"sessionID\":\"$MIDCHILD\".*background-agent-resume" "$EVIDENCE_DIR/12-plugin-log-after-resume.txt" 2>/dev/null | tr -d ' ')"
RESUME_SKIPPED="$(grep -c "skipped because latest assistant is still active.*\"sessionID\":\"$MIDCHILD\"" "$EVIDENCE_DIR/12-plugin-log-after-resume.txt" 2>/dev/null | tr -d ' ')"
RESUME_REACHED="$(grep -cE "\"sessionID\":\"$MIDCHILD\",\"source\":\"background-agent-resume\"|resume prompt skipped by promptAsync gate.*$MIDCHILD" "$EVIDENCE_DIR/12-plugin-log-after-resume.txt" 2>/dev/null | tr -d ' ')"

# ---- AGENT IDENTITY ORACLE ----
# The adopted task must carry the agent the child ACTUALLY ran under (the probe spawns
# it as subagent_type "explore"), never the fabricated "continue" that made adopted
# tasks die with `Agent "continue" not found`. Read the agent off the resume dispatch
# log line for this child, which is what gets sent as the prompt body's `agent` field.
grep -F "Resuming task - calling prompt" "$EVIDENCE_DIR/12-plugin-log-after-resume.txt" > "$EVIDENCE_DIR/17-resume-dispatch-lines.txt" 2>/dev/null
ADOPTED_AGENT="$(grep -F "$MIDCHILD" "$EVIDENCE_DIR/17-resume-dispatch-lines.txt" 2>/dev/null | grep -oE '"agent":"[^"]*"' | head -1 | cut -d'"' -f4)"
FABRICATED_AGENT="$(grep -cE "\"agent\":\"continue\"" "$EVIDENCE_DIR/13-child-log-lines.txt" 2>/dev/null | tr -d ' ')"
AGENT_NOT_FOUND="$(grep -cE 'Agent "continue" not found' "$EVIDENCE_DIR/12-plugin-log-after-resume.txt" 2>/dev/null | tr -d ' ')"

{ printf 'resume_path_reached=%s\n' "${RESUME_REACHED:-0}"
  printf 'resume_dispatched=%s\n' "${RESUME_DISPATCHED:-0}"
  printf 'resume_skipped_tool_state=%s\n' "${RESUME_SKIPPED:-0}"
  printf 'adopted_agent=%s\n' "${ADOPTED_AGENT:-<none>}"
  printf 'fabricated_continue_agent_lines=%s\n' "${FABRICATED_AGENT:-0}"
  printf 'agent_continue_not_found_errors=%s\n' "${AGENT_NOT_FOUND:-0}"
  printf 'midpre=%s midpost=%s unterminated=%s\n' "$MIDPRE" "$MIDPOST" "$UNTERM"; } > "$EVIDENCE_DIR/14-oracle.txt"

# The resume code path MUST have run, in both polarities. If it did not, the probe is
# measuring nothing and must fail loudly rather than report a colour.
[ "${RESUME_REACHED:-0}" -gt 0 ] || { echo "PROBE INVALID: manager.resume() never reached the prompt gate for $MIDCHILD (check run_in_background=true routing)" >&2; cat "$EVIDENCE_DIR/14-oracle.txt" >&2; exit 1; }

if [ "$EXPECT_BLOCKED" -eq 1 ]; then
  VERDICT=FAIL
  [ "${RESUME_SKIPPED:-0}" -gt 0 ] && [ "${RESUME_DISPATCHED:-0}" -eq 0 ] && VERDICT=PASS
  printf 'MODE=negative-control (expect gate to BLOCK)\nVERDICT=%s\n' "$VERDICT" > "$EVIDENCE_DIR/15-verdict.txt"
elif [ "$EXPECT_FABRICATED_AGENT" -eq 1 ]; then
  # Negative control for the agent-identity fix: against a build that still fabricates
  # the agent, the adopted task MUST show agent "continue". If it does not, this probe
  # is not measuring the identity defect and its PASS proves nothing.
  VERDICT=FAIL
  [ "$ADOPTED_AGENT" = "continue" ] && VERDICT=PASS
  printf 'MODE=negative-control-agent-identity (expect fabricated agent)\nadopted_agent=%s\nVERDICT=%s\n' "${ADOPTED_AGENT:-<none>}" "$VERDICT" > "$EVIDENCE_DIR/15-verdict.txt"
else
  VERDICT=FAIL
  # The adopted task must dispatch AND carry a real recovered agent. The probe spawns
  # its child as subagent_type "explore", so that is the only correct value here.
  if [ "${RESUME_DISPATCHED:-0}" -gt 0 ] && [ "${RESUME_SKIPPED:-0}" -eq 0 ]; then
    if [ "$ADOPTED_AGENT" = "explore" ]; then
      VERDICT=PASS
    else
      printf 'AGENT IDENTITY FAILURE: adopted agent was "%s", expected "explore"\n' "${ADOPTED_AGENT:-<none>}" >&2
    fi
  fi
  printf 'MODE=fixed (expect gate to DISPATCH under the recovered agent)\nadopted_agent=%s\nVERDICT=%s\n' "${ADOPTED_AGENT:-<none>}" "$VERDICT" > "$EVIDENCE_DIR/15-verdict.txt"
fi
cat "$EVIDENCE_DIR/14-oracle.txt" "$EVIDENCE_DIR/15-verdict.txt"

AFTER="$(sqlite3 "$HOST_DB" 'SELECT count(*) FROM session')"; printf '%s\n' "$AFTER" > "$EVIDENCE_DIR/16-host-session-count-after.txt"
[ "$BEFORE" = "$AFTER" ] || { echo "ISOLATION BREACH: host session count changed $BEFORE -> $AFTER" >&2; exit 1; }
[ "$SELF_TEST" -eq 0 ] || [ "$VERDICT" = PASS ]
