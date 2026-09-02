#!/usr/bin/env bash
# RW2 QA driver. One invocation = one scenario = one output dir.
#
# Isolation (both traps handled):
#   1. source script/agent/qa-sandbox.sh  -> temp XDG_* + CODEX_HOME
#   2. HOME is sandboxed too              -> omo-config-core reads the user
#                                            config layer from HOME, so the real
#                                            ~/.omo/omo.jsonc would leak in.
#   3. plugin loaded from SOURCE          -> dist/index.js predates the change
#                                            and lacks wall_clock_yield entirely.
#
# Usage:
#   rw2-run.sh <label>
# Env knobs (all optional):
#   WALL_MS=60000|none|<n>   syncWallClockTimeoutMs (none = key omitted)
#   POLL_MS=<n>              syncPollTimeoutMs
#   RUN_IN_BACKGROUND=false|true|omit|<literal>
#   PARENT_AFTER_TASK=hold|bg_output|end
#   TASK_COUNT=<n>  CHILD_TURNS=<n>  CHILD_SLEEP_S=<n>  PARENT_HOLD_S=<n>
#   CHILD_SPAWNS_BG=1  WAKE_ECHO=1
#   RUN_TIMEOUT_S=<n>        watchdog bound on `opencode run`
#   EXTRA_BG_JSON='"k":v,'   raw extra keys inside background_task
#   POST_RUN_PROBE_S=<n>     after the run exits, keep sampling for N seconds
#                            (orphan detection)

set -uo pipefail

LABEL="${1:?label required}"
REPO="/Users/tim/git/oh-my-openagent"
EVID="$REPO/.omo/evidence/20260806-bounded-sync-delegation"
OUT="/tmp/omo-qa-rw2/out/$LABEL"

WALL_MS="${WALL_MS:-60000}"
POLL_MS="${POLL_MS:-}"
RUN_IN_BACKGROUND="${RUN_IN_BACKGROUND:-false}"
PARENT_AFTER_TASK="${PARENT_AFTER_TASK:-hold}"
TASK_COUNT="${TASK_COUNT:-1}"
CHILD_TURNS="${CHILD_TURNS:-20}"
CHILD_SLEEP_S="${CHILD_SLEEP_S:-6}"
PARENT_HOLD_S="${PARENT_HOLD_S:-90}"
CHILD_SPAWNS_BG="${CHILD_SPAWNS_BG:-0}"
WAKE_ECHO="${WAKE_ECHO:-1}"
RUN_TIMEOUT_S="${RUN_TIMEOUT_S:-420}"
EXTRA_BG_JSON="${EXTRA_BG_JSON:-}"
POST_RUN_PROBE_S="${POST_RUN_PROBE_S:-0}"
CHILD_FINAL_TEXT="${CHILD_FINAL_TEXT:-CHILD_DELIVERABLE_PAYLOAD_9F3A}"

rm -rf "$OUT"; mkdir -p "$OUT"
log() { printf '[rw2:%s] %s\n' "$LABEL" "$*" >&2; }

REAL_DB="$(opencode db path 2>/dev/null | head -1)"
DB_BEFORE="$(sqlite3 "$REAL_DB" 'SELECT count(*) FROM session')"
log "real DB: $REAL_DB  sessions BEFORE=$DB_BEFORE"
printf '%s\n' "$REAL_DB"    >"$OUT/real-db-path.txt"
printf '%s\n' "$DB_BEFORE"  >"$OUT/db-before.txt"

REAL_HOME="$HOME"

# ---- 1. isolation ------------------------------------------------------------
cd "$REPO" || exit 1
# shellcheck disable=SC1091
. script/agent/qa-sandbox.sh

SANDBOX_HOME="$OMO_QA_ROOT/home"
mkdir -p "$SANDBOX_HOME/.omo"
if [ -d "$REAL_HOME/.opencode/bin" ]; then
  mkdir -p "$SANDBOX_HOME/.opencode"
  ln -s "$REAL_HOME/.opencode/bin" "$SANDBOX_HOME/.opencode/bin" 2>/dev/null || true
fi
export HOME="$SANDBOX_HOME"
export OPENCODE_TEST_HOME="$SANDBOX_HOME"
log "sandbox root=$OMO_QA_ROOT HOME=$HOME"

PROJ="$OMO_QA_ROOT/proj"; mkdir -p "$PROJ"

# ---- 2. fake provider --------------------------------------------------------
FAKE_LOG="$OUT/fake-llm.log"; FAKE_STDOUT="$OUT/fake-llm.stdout"; : >"$FAKE_LOG"
FAKE_LLM_LOG="$FAKE_LOG" FAKE_OPENAI_PORT=0 \
  CHILD_TURNS="$CHILD_TURNS" CHILD_SLEEP_S="$CHILD_SLEEP_S" \
  RUN_IN_BACKGROUND="$RUN_IN_BACKGROUND" PARENT_AFTER_TASK="$PARENT_AFTER_TASK" \
  PARENT_HOLD_S="$PARENT_HOLD_S" TASK_COUNT="$TASK_COUNT" \
  CHILD_SPAWNS_BG="$CHILD_SPAWNS_BG" WAKE_ECHO="$WAKE_ECHO" \
  CHILD_FINAL_TEXT="$CHILD_FINAL_TEXT" \
  bun run --bun "$EVID/rw2-fake-llm.mjs" >"$FAKE_STDOUT" 2>&1 &
FAKE_PID=$!

FAKE_PORT=""
for _ in $(seq 1 40); do
  if grep -q '^fake-openai listening on ' "$FAKE_STDOUT" 2>/dev/null; then
    FAKE_PORT="$(grep '^fake-openai listening on ' "$FAKE_STDOUT" | head -1 | awk '{print $NF}')"; break
  fi
  kill -0 "$FAKE_PID" 2>/dev/null || { log "FATAL: fake provider died"; cat "$FAKE_STDOUT" >&2; exit 1; }
  sleep 0.25
done
[ -n "$FAKE_PORT" ] || { log "FATAL: no port"; exit 1; }
log "fake provider pid=$FAKE_PID port=$FAKE_PORT"
printf 'fake_llm_pid=%s\nfake_llm_port=%s\nsandbox_root=%s\nsandbox_home=%s\n' \
  "$FAKE_PID" "$FAKE_PORT" "$OMO_QA_ROOT" "$HOME" >"$OUT/spawned-resources.txt"

# ---- 3. configs --------------------------------------------------------------
mkdir -p "$XDG_CONFIG_HOME/opencode"
cat >"$XDG_CONFIG_HOME/opencode/opencode.jsonc" <<JSONC
{
  "plugin": ["file://${REPO}/packages/omo-opencode/src/index.ts"],
  "model": "openai/gpt-fake",
  "provider": {
    "openai": {
      "options": { "apiKey": "fake-key", "baseURL": "http://127.0.0.1:${FAKE_PORT}/v1", "timeout": 600000 },
      "models": { "gpt-fake": { "tool_call": true, "limit": { "context": 200000, "output": 8192 } } }
    }
  },
  "permission": { "bash": "allow", "task": "allow", "call_omo_agent": "allow", "background_output": "allow" }
}
JSONC

BG_KEYS='"defaultConcurrency": 4'
[ "$WALL_MS" = "none" ] || BG_KEYS="$BG_KEYS, \"syncWallClockTimeoutMs\": ${WALL_MS}"
[ -z "$POLL_MS" ]       || BG_KEYS="$BG_KEYS, \"syncPollTimeoutMs\": ${POLL_MS}"
[ -z "$EXTRA_BG_JSON" ] || BG_KEYS="$BG_KEYS, ${EXTRA_BG_JSON}"

cat >"$HOME/.omo/omo.jsonc" <<JSONC
{
  "[opencode]": {
    "background_task": { ${BG_KEYS} },
    "agents": {
      "explore": { "model": "openai/gpt-fake" },
      "librarian": { "model": "openai/gpt-fake" },
      "sisyphus-junior": { "model": "openai/gpt-fake" }
    }
  }
}
JSONC
cp "$HOME/.omo/omo.jsonc" "$OUT/omo.jsonc"
cp "$XDG_CONFIG_HOME/opencode/opencode.jsonc" "$OUT/opencode.jsonc"
log "config: WALL_MS=$WALL_MS POLL_MS=${POLL_MS:-default} RIB=$RUN_IN_BACKGROUND AFTER=$PARENT_AFTER_TASK TASKS=$TASK_COUNT"

# ---- 4. drive ----------------------------------------------------------------
RUN_JSONL="$OUT/run.jsonl"; RUN_STDERR="$OUT/run.stderr"; : >"$RUN_JSONL"
RUN_STARTED_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
printf '%s\n' "$RUN_STARTED_MS" >"$OUT/run-started-epoch-ms.txt"

cd "$PROJ" || exit 1
opencode run "Run the wallclock probe" --format json >"$RUN_JSONL" 2>"$RUN_STDERR" &
RUN_PID=$!

SAMPLES="$OUT/session-samples.tsv"
printf 'epoch_ms\tsession_id\tparent_id\tagent\ttime_updated\n' >"$SAMPLES"
SDB="$XDG_DATA_HOME/opencode/opencode.db"
(
  while kill -0 "$RUN_PID" 2>/dev/null; do
    if [ -f "$SDB" ]; then
      NOW="$(node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null)"
      sqlite3 -separator $'\t' "$SDB" \
        "SELECT '$NOW', id, coalesce(parent_id,''), coalesce(agent,''), time_updated FROM session" >>"$SAMPLES" 2>/dev/null
    fi
    sleep 1
  done
) & SAMPLER_PID=$!

printf 'watchdog_bound_s=%s fired=no\n' "$RUN_TIMEOUT_S" >"$OUT/watchdog.txt"
( sleep "$RUN_TIMEOUT_S"
  if kill -0 "$RUN_PID" 2>/dev/null; then
    printf 'watchdog_bound_s=%s fired=YES killed_pid=%s\n' "$RUN_TIMEOUT_S" "$RUN_PID" >"$OUT/watchdog.txt"
    kill -9 "$RUN_PID" 2>/dev/null
  fi ) & WATCHDOG_PID=$!

wait "$RUN_PID"; RUN_EXIT=$?
kill "$WATCHDOG_PID" 2>/dev/null; kill "$SAMPLER_PID" 2>/dev/null
RUN_ENDED_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
printf '%s\n' "$RUN_ENDED_MS" >"$OUT/run-ended-epoch-ms.txt"
printf '%s\n' "$RUN_EXIT"     >"$OUT/run-exit.txt"
log "run exit=$RUN_EXIT elapsed=$(( (RUN_ENDED_MS - RUN_STARTED_MS) / 1000 ))s"

# ---- 4b. post-run orphan probe ----------------------------------------------
if [ "$POST_RUN_PROBE_S" -gt 0 ]; then
  log "post-run orphan probe for ${POST_RUN_PROBE_S}s"
  ORPH="$OUT/post-run-probe.txt"
  : >"$ORPH"
  for i in $(seq 1 "$POST_RUN_PROBE_S"); do
    {
      printf 't+%ss opencode_procs=%s child_sleep_procs=%s fake_calls=%s\n' "$i" \
        "$(pgrep -f 'opencode' 2>/dev/null | wc -l | tr -d ' ')" \
        "$(pgrep -f 'CHILD_ALIVE_TURN' 2>/dev/null | wc -l | tr -d ' ')" \
        "$(curl -s "http://127.0.0.1:$FAKE_PORT/state" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write(String(j.childTurns))}catch{process.stdout.write("?")}})' 2>/dev/null)"
    } >>"$ORPH"
    sleep 1
  done
fi

# ---- 5. snapshot sandbox DB --------------------------------------------------
if [ -f "$SDB" ]; then
  rm -f "$OUT/sandbox-opencode.db"
  sqlite3 "$SDB" ".backup '$OUT/sandbox-opencode.db'" 2>/dev/null || cp "$SDB" "$OUT/sandbox-opencode.db"
  SNAP="$OUT/sandbox-opencode.db"
  sqlite3 "$SNAP" 'SELECT count(*) FROM session' >"$OUT/sandbox-db-sessions.txt" 2>/dev/null
  sqlite3 -header -column "$SNAP" \
    'SELECT id, parent_id, agent, title, time_created, time_updated FROM session ORDER BY time_created' >"$OUT/sandbox-sessions.txt" 2>/dev/null
  sqlite3 -header -column "$SNAP" \
    "SELECT session_id, id, coalesce(json_extract(data,'\$.role'),'') AS role, time_created, time_updated FROM message ORDER BY time_created" >"$OUT/sandbox-messages.txt" 2>/dev/null
  sqlite3 -header -column "$SNAP" \
    "SELECT session_id, coalesce(json_extract(data,'\$.tool'),'') AS tool, coalesce(json_extract(data,'\$.state.status'),'') AS status, coalesce(json_extract(data,'\$.state.time.start'),0) AS t_start, coalesce(json_extract(data,'\$.state.time.end'),0) AS t_end, substr(coalesce(json_extract(data,'\$.state.input.command'),''),1,44) AS cmd FROM part WHERE json_extract(data,'\$.type')='tool' ORDER BY t_start" >"$OUT/sandbox-tool-parts.txt" 2>/dev/null
  # full text of every text part, for result-delivery greps
  sqlite3 "$SNAP" \
    "SELECT session_id || ' | ' || coalesce(json_extract(data,'\$.text'),'') FROM part WHERE json_extract(data,'\$.type')='text' ORDER BY id" >"$OUT/sandbox-text-parts.txt" 2>/dev/null
  # tool OUTPUT (what the task tool actually returned to the parent)
  sqlite3 "$SNAP" \
    "SELECT session_id || ' | tool=' || coalesce(json_extract(data,'\$.tool'),'') || ' | ' || substr(replace(coalesce(json_extract(data,'\$.state.output'),''), char(10), ' \\n '),1,900) FROM part WHERE json_extract(data,'\$.type')='tool' ORDER BY id" >"$OUT/sandbox-tool-outputs.txt" 2>/dev/null
else
  printf 'no-sandbox-db\n' >"$OUT/sandbox-db-sessions.txt"
fi
cp "${TMPDIR:-/tmp}/oh-my-opencode.log" "$OUT/plugin.log" 2>/dev/null || true

# ---- 6. teardown -------------------------------------------------------------
kill -TERM "$FAKE_PID" 2>/dev/null; sleep 1; kill -9 "$FAKE_PID" 2>/dev/null
sleep 0.5
pkill -f "echo CHILD_ALIVE_TURN" 2>/dev/null
pkill -f "echo PARENT_HOLD_DONE" 2>/dev/null
{
  printf 'fake_llm_pid=%s alive_after_kill=%s\n' "$FAKE_PID" "$(kill -0 "$FAKE_PID" 2>/dev/null && echo yes || echo no)"
  printf 'fake_llm_port=%s listeners=%s\n' "$FAKE_PORT" "$(lsof -nP -iTCP:"$FAKE_PORT" -sTCP:LISTEN 2>/dev/null | wc -l | tr -d ' ')"
  printf 'opencode_run_pid=%s alive=%s\n' "$RUN_PID" "$(kill -0 "$RUN_PID" 2>/dev/null && echo yes || echo no)"
  printf 'leftover_child_sleep_procs=%s\n' "$(pgrep -f 'CHILD_ALIVE_TURN' 2>/dev/null | wc -l | tr -d ' ')"
  printf 'leftover_parent_hold_procs=%s\n' "$(pgrep -f 'PARENT_HOLD_DONE' 2>/dev/null | wc -l | tr -d ' ')"
  printf 'sandbox_root=%s\n' "$OMO_QA_ROOT"
} >"$OUT/cleanup-receipts.txt"

DB_AFTER="$(sqlite3 "$REAL_DB" 'SELECT count(*) FROM session')"
printf '%s\n' "$DB_AFTER" >"$OUT/db-after.txt"
log "sessions AFTER=$DB_AFTER (before=$DB_BEFORE)"
printf '%s\n' "$OMO_QA_ROOT" >"$OUT/sandbox-root.txt"
log "DONE out=$OUT"
