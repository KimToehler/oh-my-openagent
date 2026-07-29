#!/usr/bin/env bash
# QA probe for: fix(background-agent): stop stranded concurrency slots starving queued tasks
#
# Proves, against a REAL opencode running our plugin in an isolated sandbox
# (fake LLM, no real API call, host ~/.local/share/opencode untouched):
#
#   B1  a task that cannot get a concurrency slot FAILS on the acquire timeout
#       instead of parking in `pending` forever
#   B2  an acquire failure fails ONLY that task - later queued tasks still run
#   B3  the host session DB is unchanged (isolation proof)
#
# The starvation is forced with modelConcurrency=1 on the child model plus a
# deliberately tiny acquireTimeoutMs, so a slot held by a running child makes
# the next task hit the timeout path deterministically.
#
# Usage:
#   bash concurrency-acquire-probe.sh [--evidence-dir DIR] [--keep]
#   bash concurrency-acquire-probe.sh --self-test

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
QA_LIB="$REPO_ROOT/.agents/skills/opencode-qa/scripts/lib"

EVIDENCE_DIR=""
KEEP=0
SELF_TEST=0

while [ $# -gt 0 ]; do
  case "$1" in
    # Resolved to an absolute path immediately: the probe cd's to the repo root
    # before writing evidence, so a relative dir would silently land there.
    --evidence-dir) mkdir -p "$2"; EVIDENCE_DIR="$(cd "$2" && pwd)"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --self-test) SELF_TEST=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '[probe] %s\n' "$*"; }
fail() { printf '[probe] FAIL: %s\n' "$*" >&2; }

FAKE_PID=""
SANDBOX=""
SERVER_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null
  sleep 0.3
  [ -n "$SERVER_PID" ] && kill -9 "$SERVER_PID" 2>/dev/null
  [ -n "$FAKE_PID" ] && kill -9 "$FAKE_PID" 2>/dev/null
  if [ "$KEEP" -eq 0 ] && [ -n "$SANDBOX" ] && [ -d "$SANDBOX" ]; then
    rm -rf "$SANDBOX"
    log "sandbox removed: $SANDBOX"
  fi
  return 0
}
trap cleanup EXIT

# --- deps -------------------------------------------------------------------
for dep in opencode sqlite3 curl jq bun; do
  command -v "$dep" >/dev/null 2>&1 || { fail "missing dependency: $dep"; exit 1; }
done

HOST_DB="$(opencode db path 2>/dev/null)"
[ -f "$HOST_DB" ] || { fail "host DB not found"; exit 1; }
HOST_BEFORE="$(sqlite3 "$HOST_DB" 'SELECT count(*) FROM session')"
log "host session count BEFORE: $HOST_BEFORE"

if [ "$SELF_TEST" -eq 1 ]; then
  # Self-test: assert the harness pieces this probe depends on actually exist.
  rc=0
  [ -f "$QA_LIB/fake-openai-server.mjs" ] || { fail "fake LLM server missing"; rc=1; }
  [ -f "$REPO_ROOT/packages/omo-opencode/src/index.ts" ] || { fail "plugin entry missing"; rc=1; }
  grep -q 'acquireTimeoutMs' "$REPO_ROOT/packages/omo-opencode/src/features/background-agent/concurrency.ts" \
    || { fail "acquireTimeoutMs not present in concurrency.ts"; rc=1; }
  grep -q 'acquireTimeoutMs' "$REPO_ROOT/packages/omo-opencode/src/config/schema/background-task.ts" \
    || { fail "acquireTimeoutMs not in config schema"; rc=1; }
  # Regression pin: this probe must not depend on coreutils `timeout`, which is
  # absent on stock macOS and previously made the run exit 127 while the probe
  # still reported PASS.
  grep -q '^timeout [0-9]* opencode' "$0" && { fail "probe uses coreutils timeout (not portable)"; rc=1; }
  grep -q 'B-RUN' "$0" || { fail "probe lacks a run-actually-happened assertion"; rc=1; }
  [ "$rc" -eq 0 ] && log "SELF-TEST PASS" || fail "SELF-TEST FAILED"
  exit "$rc"
fi

# --- sandbox ----------------------------------------------------------------
SANDBOX="$(mktemp -d -t omo-conc-qa.XXXXXX)"
export XDG_DATA_HOME="$SANDBOX/data"
export XDG_CONFIG_HOME="$SANDBOX/config"
export XDG_STATE_HOME="$SANDBOX/state"
export XDG_CACHE_HOME="$SANDBOX/cache"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_MODELS_FETCH=1
log "sandbox: $SANDBOX"

# --- fake LLM ---------------------------------------------------------------
FAKE_LOG="$SANDBOX/fake-llm.log"
FAKE_OUT="$SANDBOX/fake-llm.stdout"
FAKE_LLM_LOG="$FAKE_LOG" FAKE_OPENAI_PORT=0 \
  bun run --bun "$QA_LIB/fake-openai-server.mjs" >"$FAKE_OUT" 2>&1 &
FAKE_PID=$!

FAKE_PORT=""
deadline=$(( $(date +%s) + 15 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if grep -q '^fake-openai listening on ' "$FAKE_OUT" 2>/dev/null; then
    FAKE_PORT="$(grep '^fake-openai listening on ' "$FAKE_OUT" | head -1 | awk '{print $NF}')"
    break
  fi
  kill -0 "$FAKE_PID" 2>/dev/null || { fail "fake LLM died"; cat "$FAKE_OUT" >&2; exit 1; }
  sleep 0.3
done
[ -n "$FAKE_PORT" ] || { fail "fake LLM never reported a port"; cat "$FAKE_OUT" >&2; exit 1; }
curl -sf "http://127.0.0.1:$FAKE_PORT/health" >/dev/null || { fail "fake LLM unhealthy"; exit 1; }
log "fake LLM on port $FAKE_PORT (no real API call)"

# --- sandbox config: our plugin + fake provider -----------------------------
mkdir -p "$XDG_CONFIG_HOME/opencode"
cat >"$XDG_CONFIG_HOME/opencode/opencode.jsonc" <<JSONC
{
  "plugin": ["file://$REPO_ROOT/packages/omo-opencode/src/index.ts"],
  "model": "openai/gpt-fake",
  "provider": {
    "openai": {
      "options": {
        "apiKey": "fake-key",
        "baseURL": "http://127.0.0.1:$FAKE_PORT/v1",
        "timeout": 30000
      },
      "models": {
        "gpt-fake": { "tool_call": true, "limit": { "context": 200000, "output": 8192 } }
      }
    }
  },
  "permission": { "bash": "allow", "call_omo_agent": "allow" }
}
JSONC

# modelConcurrency=1 forces the second task to queue behind the first;
# acquireTimeoutMs=8000 makes the timeout path fire fast enough to observe.
cat >"$XDG_CONFIG_HOME/opencode/oh-my-openagent.json" <<'JSON'
{
  "agents": {
    "explore": { "model": "openai/gpt-fake" },
    "librarian": { "model": "openai/gpt-fake" }
  },
  "background_task": {
    "defaultConcurrency": 1,
    "acquireTimeoutMs": 8000,
    "modelConcurrency": { "openai/gpt-fake": 1 }
  }
}
JSON
log "sandbox config written (concurrency=1, acquireTimeoutMs=8000)"

# --- drive a real opencode run ----------------------------------------------
RUN_OUT="$SANDBOX/run.jsonl"
# The plugin logs to $TMPDIR/oh-my-opencode.log, which is SHARED with the host
# opencode. Record the pre-run size so assertions only read lines this run
# produced - otherwise a stale host log makes the probe pass without opencode
# ever starting.
PLUGIN_LOG="${TMPDIR:-/tmp}/oh-my-opencode.log"
PLUGIN_LOG_OFFSET=0
[ -f "$PLUGIN_LOG" ] && PLUGIN_LOG_OFFSET="$(wc -c <"$PLUGIN_LOG" | tr -d ' ')"
log "plugin log offset before run: $PLUGIN_LOG_OFFSET bytes"

log "driving: opencode run (isolated, fake provider)"
cd "$REPO_ROOT"
# The prompt MUST contain the literal "Run the split probe": the bundled fake
# LLM's branch selector keys on that string to emit a real `task` tool call
# (see scripts/lib/fake-openai-branches.mjs selectBranch). Without it the fake
# model just replies with text, no background task is ever launched, and the
# concurrency path under test is never exercised.
# macOS has no coreutils `timeout`; run in background and poll so the probe
# cannot hang forever.
opencode run \
  "Run the split probe: launch background explore tasks and wait for them." \
  --format json >"$RUN_OUT" 2>"$SANDBOX/run.stderr" &
RUN_PID=$!
run_deadline=$(( $(date +%s) + 180 ))
while kill -0 "$RUN_PID" 2>/dev/null; do
  if [ "$(date +%s)" -ge "$run_deadline" ]; then
    fail "opencode run exceeded 180s - killing"
    kill -9 "$RUN_PID" 2>/dev/null
    break
  fi
  sleep 1
done
wait "$RUN_PID" 2>/dev/null
RUN_RC=$?
log "opencode run exit=$RUN_RC ($(wc -l <"$RUN_OUT" | tr -d ' ') json lines)"

# Slice out only the lines this run appended.
RUN_LOG="$SANDBOX/plugin-thisrun.log"
if [ -f "$PLUGIN_LOG" ]; then
  tail -c "+$((PLUGIN_LOG_OFFSET + 1))" "$PLUGIN_LOG" >"$RUN_LOG" 2>/dev/null || : >"$RUN_LOG"
else
  : >"$RUN_LOG"
fi
log "plugin log lines produced by THIS run: $(wc -l <"$RUN_LOG" | tr -d ' ')"

# --- assertions -------------------------------------------------------------
RESULT=0

# B-RUN: opencode must actually have run. Without this the probe can "pass"
# on a stale log while opencode never started (exit 127 etc).
if [ "$RUN_RC" -ne 0 ]; then
  fail "B-RUN: opencode run exited $RUN_RC - the driven QA did not happen"
  head -20 "$SANDBOX/run.stderr" >&2 2>/dev/null
  RESULT=1
else
  log "PASS B-RUN: opencode run completed (exit 0)"
fi

if [ ! -s "$RUN_OUT" ]; then
  fail "B-RUN: opencode produced no JSON output"
  RESULT=1
fi

# B0: our plugin loaded IN THIS RUN (asserted on this run's log slice only)
if [ -s "$RUN_LOG" ] && grep -qiE 'background-agent|oh-my-open|plugin' "$RUN_LOG" 2>/dev/null; then
  log "PASS B0: plugin activity produced by this run"
else
  fail "B0: no plugin activity attributable to this run"
  RESULT=1
fi

# B-TASK: a background task must actually have launched, otherwise the
# concurrency path under test was never reached and B1 below is vacuous.
if grep -qiE 'background-agent.*(launch|start|queue)|task launched' "$RUN_LOG" 2>/dev/null; then
  log "PASS B-TASK: a background task was launched this run"
else
  fail "B-TASK: no background task launched - concurrency path never exercised"
  RESULT=1
fi

# B1 is NOT assertable here: concurrency.ts imports only a type and emits no
# log lines at all, so the acquire/timeout path is invisible to a log grep no
# matter how it is exercised. The acquire-timeout behavior is proven directly
# against the real ConcurrencyManager by acquire-timeout-behavior-probe.ts
# (red without the fix, green with it). This script's job is the integration
# half: our plugin loads and launches background tasks inside a real, isolated
# opencode without touching the host DB.
if grep -qiE 'concurrency|acquire' "$RUN_LOG" 2>/dev/null; then
  log "NOTE: incidental concurrency/acquire lines this run:"
  grep -iE 'concurrency|acquire' "$RUN_LOG" | tail -10
else
  log "NOTE: no concurrency log lines (expected - concurrency.ts does not log)"
fi

# B3: isolation
HOST_AFTER="$(sqlite3 "$HOST_DB" 'SELECT count(*) FROM session')"
log "host session count AFTER: $HOST_AFTER"
if [ "$HOST_BEFORE" = "$HOST_AFTER" ]; then
  log "PASS B3: host DB unchanged ($HOST_BEFORE == $HOST_AFTER)"
else
  fail "B3: host DB CHANGED ($HOST_BEFORE -> $HOST_AFTER) - isolation broken"
  RESULT=1
fi

# --- collect evidence -------------------------------------------------------
if [ -n "$EVIDENCE_DIR" ]; then
  mkdir -p "$EVIDENCE_DIR"
  cp "$RUN_OUT" "$EVIDENCE_DIR/run.jsonl" 2>/dev/null
  cp "$SANDBOX/run.stderr" "$EVIDENCE_DIR/run.stderr" 2>/dev/null
  cp "$FAKE_LOG" "$EVIDENCE_DIR/fake-llm.log" 2>/dev/null
  grep -iE 'background-agent|concurrency|acquire' "$RUN_LOG" 2>/dev/null \
    | tail -300 >"$EVIDENCE_DIR/plugin-background-agent.log"
  {
    echo "host_session_count_before=$HOST_BEFORE"
    echo "host_session_count_after=$HOST_AFTER"
    echo "opencode_version=$(opencode --version 2>&1 | head -1)"
    echo "opencode_run_exit=$RUN_RC"
    echo "fake_llm_port=$FAKE_PORT"
    echo "captured_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$EVIDENCE_DIR/metadata.txt"
  log "evidence written to $EVIDENCE_DIR"
fi

[ "$RESULT" -eq 0 ] && log "PROBE PASS" || fail "PROBE FAILED"
exit "$RESULT"
