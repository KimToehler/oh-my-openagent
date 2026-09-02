#!/usr/bin/env bash
# Task 11 QA driver: option C (bounded sync delegation) on real opencode.
#
# Isolation, in order:
#   1. source script/agent/qa-sandbox.sh -> temp XDG_* + CODEX_HOME + offline flags
#   2. additionally sandbox HOME         -> omo-config-core resolves the user config
#                                           layer from HOME, not XDG, so the real
#                                           ~/.omo/omo.jsonc would otherwise leak in
#                                           and route agents at real models.
#
# Usage: run-qa.sh <label> <wall_clock_ms|none>
#   label          - output subdir under /tmp/omo-qa-t11/out
#   wall_clock_ms  - value for background_task.syncWallClockTimeoutMs, or "none"
#                    to omit the key entirely (negative control)

set -uo pipefail

LABEL="${1:?label required}"
WALL_MS="${2:?wall clock ms or 'none' required}"

REPO="/Users/tim/git/oh-my-openagent"
OUT="/tmp/omo-qa-t11/out/$LABEL"
RUN_TIMEOUT_S="${RUN_TIMEOUT_S:-420}"
CHILD_TURNS="${CHILD_TURNS:-20}"
CHILD_SLEEP_S="${CHILD_SLEEP_S:-6}"
mkdir -p "$OUT"

log() { printf '[qa:%s] %s\n' "$LABEL" "$*" >&2; }

REAL_DB="$(opencode db path 2>/dev/null | head -1)"
DB_BEFORE="$(sqlite3 "$REAL_DB" 'SELECT count(*) FROM session')"
log "real DB: $REAL_DB"
log "session count BEFORE: $DB_BEFORE"
printf '%s\n' "$REAL_DB" >"$OUT/real-db-path.txt"
printf '%s\n' "$DB_BEFORE" >"$OUT/db-before.txt"

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
log "sandbox root: $OMO_QA_ROOT"
log "sandbox HOME: $HOME"

PROJ="$OMO_QA_ROOT/proj"
mkdir -p "$PROJ"

# ---- 2. hermetic busy-child provider ----------------------------------------
FAKE_LOG="$OUT/fake-llm.log"
FAKE_STDOUT="$OUT/fake-llm.stdout"
: >"$FAKE_LOG"

FAKE_LLM_LOG="$FAKE_LOG" FAKE_OPENAI_PORT=0 \
  CHILD_TURNS="$CHILD_TURNS" CHILD_SLEEP_S="$CHILD_SLEEP_S" RUN_IN_BACKGROUND=false \
  PARENT_HOLD_S="${PARENT_HOLD_S:-90}" \
  bun run --bun /tmp/omo-qa-t11/fake-llm-busy.mjs \
  >"$FAKE_STDOUT" 2>&1 &
FAKE_PID=$!

FAKE_PORT=""
for _ in $(seq 1 40); do
  if grep -q '^fake-openai listening on ' "$FAKE_STDOUT" 2>/dev/null; then
    FAKE_PORT="$(grep '^fake-openai listening on ' "$FAKE_STDOUT" | head -1 | awk '{print $NF}')"
    break
  fi
  kill -0 "$FAKE_PID" 2>/dev/null || { log "FATAL: fake provider died"; cat "$FAKE_STDOUT" >&2; exit 1; }
  sleep 0.25
done
[ -n "$FAKE_PORT" ] || { log "FATAL: fake provider never reported a port"; exit 1; }
log "fake-llm-busy pid=$FAKE_PID port=$FAKE_PORT"

printf 'fake_llm_pid=%s\nfake_llm_port=%s\nsandbox_root=%s\nsandbox_home=%s\n' \
  "$FAKE_PID" "$FAKE_PORT" "$OMO_QA_ROOT" "$HOME" >"$OUT/spawned-resources.txt"

# ---- 3. sandbox configs ------------------------------------------------------
mkdir -p "$XDG_CONFIG_HOME/opencode"
cat >"$XDG_CONFIG_HOME/opencode/opencode.jsonc" <<JSONC
{
  "plugin": ["file://${REPO}/packages/omo-opencode/src/index.ts"],
  "model": "openai/gpt-fake",
  "provider": {
    "openai": {
      "options": {
        "apiKey": "fake-key",
        "baseURL": "http://127.0.0.1:${FAKE_PORT}/v1",
        "timeout": 600000
      },
      "models": {
        "gpt-fake": {
          "tool_call": true,
          "limit": { "context": 200000, "output": 8192 }
        }
      }
    }
  },
  "permission": {
    "bash": "allow",
    "task": "allow",
    "call_omo_agent": "allow"
  }
}
JSONC

if [ "$WALL_MS" = "none" ]; then
  BG_BLOCK='"background_task": { "defaultConcurrency": 4 }'
else
  BG_BLOCK="\"background_task\": { \"defaultConcurrency\": 4, \"syncWallClockTimeoutMs\": ${WALL_MS} }"
fi

cat >"$HOME/.omo/omo.jsonc" <<JSONC
{
  "[opencode]": {
    ${BG_BLOCK},
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
log "configs written (syncWallClockTimeoutMs=$WALL_MS)"

# ---- 4. drive opencode run, bounded by a watchdog ----------------------------
RUN_JSONL="$OUT/run.jsonl"
RUN_STDERR="$OUT/run.stderr"
: >"$RUN_JSONL"

RUN_STARTED_EPOCH_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
printf '%s\n' "$RUN_STARTED_EPOCH_MS" >"$OUT/run-started-epoch-ms.txt"

cd "$PROJ" || exit 1
opencode run "Run the wallclock probe" --format json >"$RUN_JSONL" 2>"$RUN_STDERR" &
RUN_PID=$!

# Live child-liveness sampler. Snapshots every session row from the sandbox DB
# once a second while the run is in flight, so the child's state at (and after)
# the moment the parent's tool call returned is recorded rather than inferred.
SAMPLES="$OUT/session-samples.tsv"
printf 'epoch_ms\tsession_id\tparent_id\tagent\ttime_updated\n' >"$SAMPLES"
(
  SDB="$XDG_DATA_HOME/opencode/opencode.db"
  while kill -0 "$RUN_PID" 2>/dev/null; do
    if [ -f "$SDB" ]; then
      NOW="$(node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null)"
      sqlite3 -separator $'\t' "$SDB" \
        "SELECT '$NOW', id, coalesce(parent_id,''), coalesce(agent,''), time_updated FROM session" \
        >>"$SAMPLES" 2>/dev/null
    fi
    sleep 1
  done
) &
SAMPLER_PID=$!

: >"$OUT/watchdog.txt"
printf 'watchdog_bound_s=%s fired=no\n' "$RUN_TIMEOUT_S" >"$OUT/watchdog.txt"
(
  sleep "$RUN_TIMEOUT_S"
  if kill -0 "$RUN_PID" 2>/dev/null; then
    printf 'watchdog_bound_s=%s fired=YES killed_pid=%s\n' "$RUN_TIMEOUT_S" "$RUN_PID" >"$OUT/watchdog.txt"
    kill -9 "$RUN_PID" 2>/dev/null
  fi
) &
WATCHDOG_PID=$!

wait "$RUN_PID"
RUN_EXIT=$?
kill "$WATCHDOG_PID" 2>/dev/null
kill "$SAMPLER_PID" 2>/dev/null
RUN_ENDED_EPOCH_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
printf '%s\n' "$RUN_ENDED_EPOCH_MS" >"$OUT/run-ended-epoch-ms.txt"
log "opencode run exit=$RUN_EXIT (watchdog bound ${RUN_TIMEOUT_S}s)"
printf '%s\n' "$RUN_EXIT" >"$OUT/run-exit.txt"

# ---- 5. snapshot sandbox DB BEFORE teardown ---------------------------------
SANDBOX_DB="$XDG_DATA_HOME/opencode/opencode.db"
if [ -f "$SANDBOX_DB" ]; then
  # .backup, not cp: the sandbox DB runs in WAL mode, so a plain copy misses the
  # most recent rows still sitting in the -wal file.
  rm -f "$OUT/sandbox-opencode.db"
  sqlite3 "$SANDBOX_DB" ".backup '$OUT/sandbox-opencode.db'" 2>/dev/null || cp "$SANDBOX_DB" "$OUT/sandbox-opencode.db"
  SANDBOX_DB="$OUT/sandbox-opencode.db"
  sqlite3 "$SANDBOX_DB" 'SELECT count(*) FROM session' >"$OUT/sandbox-db-sessions.txt" 2>/dev/null
  sqlite3 -header -column "$SANDBOX_DB" \
    'SELECT id, parent_id, agent, title, time_created, time_updated FROM session ORDER BY time_created' \
    >"$OUT/sandbox-sessions.txt" 2>/dev/null
  # Per-session message timeline: the child's assistant messages created AFTER the
  # parent's task tool returned are direct evidence the child kept working.
  sqlite3 -header -column "$SANDBOX_DB" \
    "SELECT session_id, id, coalesce(json_extract(data,'\$.role'),'') AS role, time_created, time_updated FROM message ORDER BY time_created" \
    >"$OUT/sandbox-messages.txt" 2>/dev/null
  sqlite3 -header -column "$SANDBOX_DB" \
    "SELECT session_id, coalesce(json_extract(data,'\$.tool'),'') AS tool, coalesce(json_extract(data,'\$.state.status'),'') AS status, coalesce(json_extract(data,'\$.state.time.start'),0) AS t_start, coalesce(json_extract(data,'\$.state.time.end'),0) AS t_end, substr(coalesce(json_extract(data,'\$.state.input.command'),''),1,44) AS cmd FROM part WHERE json_extract(data,'\$.type')='tool' ORDER BY t_start" \
    >"$OUT/sandbox-tool-parts.txt" 2>/dev/null
else
  printf 'no-sandbox-db\n' >"$OUT/sandbox-db-sessions.txt"
fi
cp "$OMO_QA_ROOT"/../oh-my-opencode.log "$OUT/plugin.log" 2>/dev/null || \
  cp "${TMPDIR:-/tmp}/oh-my-opencode.log" "$OUT/plugin.log" 2>/dev/null || true

# ---- 6. teardown -------------------------------------------------------------
kill -TERM "$FAKE_PID" 2>/dev/null; sleep 1; kill -9 "$FAKE_PID" 2>/dev/null
sleep 0.5
pkill -f "sleep ${CHILD_SLEEP_S}; echo CHILD_ALIVE_TURN" 2>/dev/null

{
  printf 'fake_llm_pid %s alive_after_kill=%s\n' "$FAKE_PID" "$(kill -0 "$FAKE_PID" 2>/dev/null && echo yes || echo no)"
  printf 'fake_llm_port %s listeners=%s\n' "$FAKE_PORT" "$(lsof -nP -iTCP:"$FAKE_PORT" -sTCP:LISTEN 2>/dev/null | wc -l | tr -d ' ')"
  printf 'opencode_run_pid %s alive=%s\n' "$RUN_PID" "$(kill -0 "$RUN_PID" 2>/dev/null && echo yes || echo no)"
  printf 'leftover_child_sleep_procs=%s\n' "$(pgrep -f 'CHILD_ALIVE_TURN' 2>/dev/null | wc -l | tr -d ' ')"
} >"$OUT/cleanup-receipts.txt"

# ---- 7. isolation proof ------------------------------------------------------
DB_AFTER="$(sqlite3 "$REAL_DB" 'SELECT count(*) FROM session')"
printf '%s\n' "$DB_AFTER" >"$OUT/db-after.txt"
log "session count AFTER: $DB_AFTER"

printf 'sandbox_root=%s\n' "$OMO_QA_ROOT" >"$OUT/sandbox-root.txt"
log "DONE. sandbox retained at $OMO_QA_ROOT"
