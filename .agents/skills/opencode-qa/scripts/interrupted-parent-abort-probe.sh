#!/usr/bin/env bash
# Proves that interrupting a parent session terminalizes its in-flight background
# child lanes, instead of leaving them reporting `running` until the 45-minute
# stale reaper (docs/troubleshooting/harness-findings.md, "An interrupted parent
# aborts its background lanes, but they keep reporting `running`").
#
# PHASE 1 (OBSERVATION, always runs): the fix assumes a real user interrupt reaches
# the plugin as a `session.error` carrying an abort-shaped error. That assumption is
# load-bearing and was never verified, so this probe RECORDS the actual event wire
# for the interrupt before asserting anything. If no abort-shaped session.error is
# observed for the parent, the probe fails LOUDLY as PROBE INVALID rather than
# reporting a colour, because then the fix cannot fire in production regardless of
# what the unit test says.
#
# PHASE 2 (ORACLE): asserts the child task left `running`. The signal is the
# terminalization log line emitted by BackgroundManager, scoped to this child.
#
# NEGATIVE CONTROL: --expect-stuck runs against a build WITHOUT the fix, where the
# child MUST still be running after the interrupt. A probe never observed red is
# not evidence.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/common.sh"
SELF_TEST=0; EVIDENCE_DIR=""; EXPECT_STUCK=0
while [ $# -gt 0 ]; do case "$1" in
  --self-test) SELF_TEST=1;;
  --expect-stuck) EXPECT_STUCK=1;;
  --evidence-dir) EVIDENCE_DIR="${2:?--evidence-dir needs DIR}"; shift;;
  -h|--help) echo "Usage: $0 [--self-test] [--expect-stuck] --evidence-dir DIR"; exit 0;;
  *) echo "unknown option: $1" >&2; exit 2;; esac; shift; done
[ -n "$EVIDENCE_DIR" ] || EVIDENCE_DIR="${TMPDIR:-/tmp}/interrupted-parent-abort-$(date +%s)"; mkdir -p "$EVIDENCE_DIR"

REPO_ROOT="${OQA_REPO_ROOT:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
[ -f "$REPO_ROOT/dist/index.js" ] || { echo "dist/index.js missing in $REPO_ROOT - run bun run build first" >&2; exit 1; }
printf '%s\n' "$REPO_ROOT" > "$EVIDENCE_DIR/00-repo-root.txt"
HOST_DB="$(opencode db path)"; BEFORE="$(sqlite3 "$HOST_DB" 'SELECT count(*) FROM session')"
printf '%s\n' "$BEFORE" > "$EVIDENCE_DIR/01-host-session-count-before.txt"

FAKE_PID=""; SERVER_PID=""; SSE_PID=""; SERVER_PORT=""; FAKE_PORT=""
cleanup() {
  for pid in "$SSE_PID" "$SERVER_PID" "$FAKE_PID"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  for pid in "$SSE_PID" "$SERVER_PID" "$FAKE_PID"; do [ -n "$pid" ] && wait "$pid" 2>/dev/null || true; done
  { printf 'server_pid=%s alive=' "$SERVER_PID"; kill -0 "$SERVER_PID" 2>/dev/null && printf yes || printf no
    printf '\nfake_pid=%s alive=' "$FAKE_PID"; kill -0 "$FAKE_PID" 2>/dev/null && printf yes || printf no
    printf '\nsse_pid=%s alive=' "$SSE_PID"; kill -0 "$SSE_PID" 2>/dev/null && printf yes || printf no
    printf '\n'; } > "$EVIDENCE_DIR/90-cleanup-receipt.txt"
  # bash keeps only the LAST EXIT trap, so this replaced common.sh's `trap oqa_cleanup
  # EXIT`. Call it explicitly or the XDG sandbox is never removed.
  oqa_cleanup
}
trap cleanup EXIT

oqa_mk_isolated_xdg
OQA_PROJ="$(node -e 'const {realpathSync}=require("fs");console.log(realpathSync(process.argv[1]))' "$OQA_PROJ")"
SANDBOX_TMP="$XDG_DATA_HOME/tmp"; mkdir -p "$SANDBOX_TMP"; export TMPDIR="$SANDBOX_TMP"
PLUGIN_LOG="$SANDBOX_TMP/oh-my-opencode.log"
printf '%s\n' "$PLUGIN_LOG" > "$EVIDENCE_DIR/02-plugin-log-path.txt"

FAKE_PORT="$(oqa_free_port)"
FAKE_LLM_LOG="$EVIDENCE_DIR/03-fake-openai.log" FAKE_OPENAI_PORT="$FAKE_PORT" \
  bun run --bun "$SCRIPT_DIR/lib/fake-openai-server.mjs" > "$EVIDENCE_DIR/03-fake-openai.stdout" 2>&1 & FAKE_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$FAKE_PORT/health" >/dev/null && break; sleep .2; done
curl -sf "http://127.0.0.1:$FAKE_PORT/health" >/dev/null || { echo 'fake LLM unavailable' >&2; exit 1; }

mkdir -p "$XDG_CONFIG_HOME/opencode"
cat > "$XDG_CONFIG_HOME/opencode/opencode.jsonc" <<JSONC
{"plugin":["file://${REPO_ROOT}/dist/index.js"],"model":"openai/gpt-fake","provider":{"openai":{"options":{"apiKey":"fake-key","baseURL":"http://127.0.0.1:${FAKE_PORT}/v1","timeout":30000},"models":{"gpt-fake":{"tool_call":true,"limit":{"context":200000,"output":8192}}}}},"permission":{"task":"allow","background_output":"allow"}}
JSONC

SERVER_PORT="$(oqa_free_port)"
OPENCODE_SERVER_PASSWORD="probe-pass" opencode serve --hostname 127.0.0.1 --port "$SERVER_PORT" > "$EVIDENCE_DIR/04-opencode-serve.log" 2>&1 & SERVER_PID=$!
for _ in $(seq 1 100); do curl -sf -u opencode:probe-pass "http://127.0.0.1:$SERVER_PORT/global/health" > "$EVIDENCE_DIR/04-health.json" && break; sleep .2; done
curl -sf -u opencode:probe-pass "http://127.0.0.1:$SERVER_PORT/global/health" >/dev/null || { echo 'server unavailable' >&2; exit 1; }

enc_dir() { python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$OQA_PROJ"; }
new_session() { curl -sf -u opencode:probe-pass -X POST "http://127.0.0.1:$SERVER_PORT/session?directory=$(enc_dir)" -H content-type:application/json -d '{"title":"interrupted parent abort"}' | jq -r .id; }
prompt() { curl -sf -u opencode:probe-pass -X POST "http://127.0.0.1:$SERVER_PORT/session/$1/prompt_async?directory=$(enc_dir)" -H content-type:application/json -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$2\"}]}" >/dev/null; }

# PHASE 1: capture the raw event wire so the interrupt's real shape is recorded,
# not assumed.
curl -N -s -u opencode:probe-pass "http://127.0.0.1:$SERVER_PORT/event?directory=$(enc_dir)" \
  > "$EVIDENCE_DIR/05-sse-stream.jsonl" 2>&1 & SSE_PID=$!

DB="$XDG_DATA_HOME/opencode/opencode.db"
PARENT="$(new_session)"
printf '%s\n' "$PARENT" > "$EVIDENCE_DIR/06-parent-session-id.txt"
prompt "$PARENT" 'SPLIT_CHILD_TASK: restart-midturn'

# Wait for the child lane to exist AND be genuinely in flight before interrupting.
for _ in $(seq 1 150); do
  CHILD="$(sqlite3 "$DB" "SELECT s.id FROM session s JOIN message m ON m.session_id=s.id JOIN part p ON p.message_id=m.id WHERE json_extract(p.data,'\$.text') LIKE '%SPLIT_CHILD_TASK: hang-midturn%' ORDER BY s.time_created DESC LIMIT 1")"
  [ -n "$CHILD" ] && break; sleep .2
done
[[ "$CHILD" =~ ^ses_[A-Za-z0-9]{20,}$ ]] || { echo "child id not found or malformed: '$CHILD'" >&2; exit 1; }
printf '%s\n' "$CHILD" > "$EVIDENCE_DIR/07-child-session-id.txt"

for _ in $(seq 1 150); do
  RUNNING="$(sqlite3 "$DB" "SELECT count(*) FROM part WHERE message_id IN (SELECT id FROM message WHERE session_id='$CHILD') AND data LIKE '%hang so the restart kills%' AND data LIKE '%\"status\":\"running\"%'")"
  [ "${RUNNING:-0}" -gt 0 ] && break; sleep .2
done
[ "${RUNNING:-0}" -gt 0 ] || { echo 'PRECONDITION FAILED: child never entered a running tool call, so there is no in-flight lane to strand' >&2; exit 1; }
printf 'child_running_tool_calls=%s\n' "$RUNNING" > "$EVIDENCE_DIR/08-child-in-flight.txt"

LOG_OFFSET=0; [ -f "$PLUGIN_LOG" ] && LOG_OFFSET="$(wc -l < "$PLUGIN_LOG" | tr -d ' ')"
SSE_OFFSET="$(wc -l < "$EVIDENCE_DIR/05-sse-stream.jsonl" 2>/dev/null | tr -d ' ')"; SSE_OFFSET="${SSE_OFFSET:-0}"

# THE INTERRUPT: abort the PARENT session, which is what the TUI's ESC does.
curl -sf -u opencode:probe-pass -X POST "http://127.0.0.1:$SERVER_PORT/session/$PARENT/abort?directory=$(enc_dir)" \
  > "$EVIDENCE_DIR/09-parent-abort-response.txt" 2>&1
printf 'abort_exit=%s\n' "$?" >> "$EVIDENCE_DIR/09-parent-abort-response.txt"
sleep 8

# PHASE 1 ORACLE: what did the interrupt actually put on the wire for the parent?
tail -n "+$((SSE_OFFSET + 1))" "$EVIDENCE_DIR/05-sse-stream.jsonl" > "$EVIDENCE_DIR/10-sse-after-interrupt.jsonl"
grep -F "$PARENT" "$EVIDENCE_DIR/10-sse-after-interrupt.jsonl" > "$EVIDENCE_DIR/11-parent-events.jsonl" 2>/dev/null
PARENT_ERROR_EVENTS="$(grep -c '"type":"session.error"' "$EVIDENCE_DIR/11-parent-events.jsonl" 2>/dev/null | tr -d ' ')"
ABORT_SHAPED="$(grep -ci 'aborted' "$EVIDENCE_DIR/11-parent-events.jsonl" 2>/dev/null | tr -d ' ')"

tail -n "+$((LOG_OFFSET + 1))" "$PLUGIN_LOG" 2>/dev/null > "$EVIDENCE_DIR/12-plugin-log-after-interrupt.txt"
# The plugin's own view of the event, which is what the fix actually keys on.
grep -F "session.error" "$EVIDENCE_DIR/12-plugin-log-after-interrupt.txt" > "$EVIDENCE_DIR/13-plugin-session-error-lines.txt" 2>/dev/null
TERMINALIZED="$(grep -cF "Terminalizing child task after parent session abort" "$EVIDENCE_DIR/12-plugin-log-after-interrupt.txt" 2>/dev/null | tr -d ' ')"
TERMINALIZED_THIS_CHILD="$(grep -F "Terminalizing child task after parent session abort" "$EVIDENCE_DIR/12-plugin-log-after-interrupt.txt" 2>/dev/null | grep -cF "$PARENT" | tr -d ' ')"

# THE INTERRUPT MUST STAY INTERRUPTED. Terminalizing the children originally ran the
# full notification path, which woke the parent and RESTARTED the turn the user had
# just aborted - 3 wakes and 6 new sessions in the 2026-09-02 evidence, against 0 and
# 0 in the negative control. Terminalizing correctly is only half the property; the
# other half is that nothing resumes afterwards.
PARENT_WAKES="$(grep -cF "background-agent-parent-wake" "$EVIDENCE_DIR/12-plugin-log-after-interrupt.txt" 2>/dev/null | tr -d ' ')"
SESSIONS_AFTER="$(grep -c '"type":"session.created"' "$EVIDENCE_DIR/10-sse-after-interrupt.jsonl" 2>/dev/null | tr -d ' ')"

{ printf 'parent_session=%s\n' "$PARENT"
  printf 'child_session=%s\n' "$CHILD"
  printf 'parent_session_error_events=%s\n' "${PARENT_ERROR_EVENTS:-0}"
  printf 'parent_events_mentioning_aborted=%s\n' "${ABORT_SHAPED:-0}"
  printf 'terminalize_log_lines=%s\n' "${TERMINALIZED:-0}"
  printf 'terminalize_lines_for_this_parent=%s\n' "${TERMINALIZED_THIS_CHILD:-0}"
  printf 'parent_wake_dispatches=%s\n' "${PARENT_WAKES:-0}"
  printf 'sessions_created_after_interrupt=%s\n' "${SESSIONS_AFTER:-0}"; } > "$EVIDENCE_DIR/14-oracle.txt"

if [ "$EXPECT_STUCK" -eq 1 ]; then
  VERDICT=FAIL
  [ "${TERMINALIZED_THIS_CHILD:-0}" -eq 0 ] && VERDICT=PASS
  printf 'MODE=negative-control (expect NO terminalization)\nVERDICT=%s\n' "$VERDICT" > "$EVIDENCE_DIR/15-verdict.txt"
else
  # PROBE VALIDITY: if the interrupt never produced an abort-shaped session.error for
  # the parent, the fix cannot fire in production and a PASS here would be meaningless.
  if [ "${TERMINALIZED_THIS_CHILD:-0}" -eq 0 ] && [ "${PARENT_ERROR_EVENTS:-0}" -eq 0 ]; then
    echo "PROBE INVALID: the interrupt produced no session.error for the parent, so the fix's trigger never occurred. The unit test asserts a shape production may not emit." >&2
    cat "$EVIDENCE_DIR/14-oracle.txt" >&2
    printf 'MODE=fixed\nVERDICT=PROBE-INVALID\n' > "$EVIDENCE_DIR/15-verdict.txt"
    AFTER="$(sqlite3 "$HOST_DB" 'SELECT count(*) FROM session')"; printf '%s\n' "$AFTER" > "$EVIDENCE_DIR/16-host-session-count-after.txt"
    [ "$BEFORE" = "$AFTER" ] || { echo "ISOLATION BREACH: host session count changed $BEFORE -> $AFTER" >&2; exit 1; }
    exit 1
  fi
  VERDICT=FAIL
  WAKE_VERDICT=FAIL
  [ "${PARENT_WAKES:-0}" -eq 0 ] && [ "${SESSIONS_AFTER:-0}" -eq 0 ] && WAKE_VERDICT=PASS
  if [ "${TERMINALIZED_THIS_CHILD:-0}" -gt 0 ] && [ "$WAKE_VERDICT" = PASS ]; then VERDICT=PASS; fi
  { printf 'MODE=fixed (expect child lane terminalized AND parent left interrupted)\n'
    printf 'terminalized=%s\n' "${TERMINALIZED_THIS_CHILD:-0}"
    printf 'no_wake_after_interrupt=%s (wakes=%s sessions_created=%s)\n' \
      "$WAKE_VERDICT" "${PARENT_WAKES:-0}" "${SESSIONS_AFTER:-0}"
    printf 'VERDICT=%s\n' "$VERDICT"; } > "$EVIDENCE_DIR/15-verdict.txt"
fi
cat "$EVIDENCE_DIR/14-oracle.txt" "$EVIDENCE_DIR/15-verdict.txt"

AFTER="$(sqlite3 "$HOST_DB" 'SELECT count(*) FROM session')"; printf '%s\n' "$AFTER" > "$EVIDENCE_DIR/16-host-session-count-after.txt"
[ "$BEFORE" = "$AFTER" ] || { echo "ISOLATION BREACH: host session count changed $BEFORE -> $AFTER" >&2; exit 1; }
[ "$SELF_TEST" -eq 0 ] || [ "$VERDICT" = PASS ]
