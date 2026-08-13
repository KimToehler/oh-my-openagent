#!/usr/bin/env bash
# blocked-escalation-probe.sh - prove the blocked-task escalation TIMERS on a real
# opencode harness: the reminder wake and the hard expiry.
#
# WHY THIS EXISTS: the blocked flow itself (child parks -> parent woken -> parent
# answers -> child resumes) is provable in one run and was proven that way. The two
# TIMERS were not, because they default to 10 and 20 minutes. They were covered only
# by fake-timer unit tests, which cannot observe the real manager wiring the real
# timers to the real wake path.
#
# HOW: both deadlines are configurable with a 1-minute floor
# (background_task.blockedRewakeMs / blockedExpiryMs, see config/schema/background-task.ts),
# so this drives rewake=60s + expiry=120s and watches a REAL run for ~3 minutes
# instead of 20. That proves the WIRING. It deliberately does NOT prove the shipped
# default values - those are pinned separately in blocked-escalation.test.ts, because
# a run that overrides both knobs can never notice a changed default.
#
# WHAT IS ASSERTED, all from a live SSE stream plus the sandbox DB:
#   1. the child parks and the parent gets the [BACKGROUND TASK BLOCKED] wake
#   2. ~60s later a SECOND wake arrives carrying the reminder marker
#      "(reminder 1 of 1, waiting Nm)"
#   3. exactly ONE reminder arrives, never two
#   4. ~120s in, the task goes terminal with "expired unanswered"
#   5. the child session is ABORTED at expiry rather than left running
#      (the F5 finding-7 regression: a park whose abort failed used to orphan it)
#
# ISOLATION: everything runs under oqa_mk_isolated_xdg. The real
# ~/.local/share/opencode DB is counted before and after and must be UNCHANGED.
#
# Usage:
#   bash blocked-escalation-probe.sh [--evidence-dir DIR]
#   bash blocked-escalation-probe.sh --self-test   # no opencode, checks the plumbing
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/common.sh"

REWAKE_MS=60000
EXPIRY_MS=120000
EVIDENCE_DIR=""
SELF_TEST=0
KEEP_SANDBOX=0

while [ $# -gt 0 ]; do
  case "$1" in
    --evidence-dir) EVIDENCE_DIR="$2"; shift 2 ;;
    --keep-sandbox) KEEP_SANDBOX=1; shift ;;
    --self-test) SELF_TEST=1; shift ;;
    *) oqa_log "unknown argument: $1"; exit 2 ;;
  esac
done

# ---- self-test -------------------------------------------------------------
# Proves the parts this script owns WITHOUT spawning opencode: the mock speaks the
# scripted turns, and the reminder/expiry assertions actually discriminate.
if [ "$SELF_TEST" = "1" ]; then
  fails=0
  script_json='[
    {"tool":"task","when":"REPORT_BLOCKED_PROBE","args":{"description":"blocked child","prompt":"call report_blocked immediately","category":"quick","run_in_background":true},"unless":"Task launched"},
    {"tool":"report_blocked","when":"background subagent","args":{"reason":"probe reason","needs":"probe needs"},"unless":"parked"},
    {"text":"parent standing by"}
  ]'
  port="$(oqa_free_port)"
  MOCK_PORT="$port" MOCK_SCRIPT="$script_json" node "$SCRIPT_DIR/lib/mock-model.mjs" >/tmp/oqa-bep-selftest.out 2>&1 &
  mock_pid=$!
  for _ in $(seq 1 50); do grep -q MOCK_LISTENING /tmp/oqa-bep-selftest.out 2>/dev/null && break; sleep 0.1; done

  body='{"model":"mock-model","tools":[{"function":{"name":"task"}}],"messages":[{"role":"user","content":"REPORT_BLOCKED_PROBE go"}]}'
  out="$(curl -s -X POST "http://127.0.0.1:$port/v1/chat/completions" -H 'Content-Type: application/json' -d "$body")"
  if printf '%s' "$out" | grep -q '"name":"task"'; then
    oqa_pass "mock emits the delegating task tool call"
  else
    oqa_log "FAIL: no task tool call; got: $out"; fails=$((fails+1))
  fi

  body2='{"model":"mock-model","tools":[{"function":{"name":"report_blocked"}}],"messages":[{"role":"user","content":"you are a background subagent"}]}'
  out2="$(curl -s -X POST "http://127.0.0.1:$port/v1/chat/completions" -H 'Content-Type: application/json' -d "$body2")"
  if printf '%s' "$out2" | grep -q '"name":"report_blocked"'; then
    oqa_pass "mock emits the report_blocked tool call for a subagent request"
  else
    oqa_log "FAIL: no report_blocked call; got: $out2"; fails=$((fails+1))
  fi

  kill "$mock_pid" 2>/dev/null || true

  # The reminder assertion must reject a stream that has the blocked header but no
  # reminder marker, and accept one that has it. A matcher that passes on both is
  # the failure mode that makes a timer look proven when it never fired.
  no_reminder='[BACKGROUND TASK BLOCKED]'
  with_reminder='[BACKGROUND TASK BLOCKED]
[BACKGROUND TASK BLOCKED] (reminder 1 of 1, waiting 1m)'
  if printf '%s' "$no_reminder" | grep -q 'reminder 1 of 1'; then
    oqa_log "FAIL: reminder matcher fired on a stream with no reminder"; fails=$((fails+1))
  else
    oqa_pass "reminder matcher rejects a blocked wake with no reminder"
  fi
  if printf '%s' "$with_reminder" | grep -q 'reminder 1 of 1, waiting'; then
    oqa_pass "reminder matcher accepts a real reminder marker"
  else
    oqa_log "FAIL: reminder matcher missed a real marker"; fails=$((fails+1))
  fi

  count_two="$(printf '%s\n%s\n' 'reminder 1 of 1, waiting 1m' 'reminder 1 of 1, waiting 2m' | grep -c 'reminder 1 of 1')"
  if [ "$count_two" = "2" ]; then
    oqa_pass "duplicate-reminder counter counts every occurrence (would catch a re-arm leak)"
  else
    oqa_log "FAIL: counter returned $count_two"; fails=$((fails+1))
  fi

  if [ "$fails" = "0" ]; then printf '\nSELF-TEST PASS\n'; exit 0; fi
  printf '\nSELF-TEST FAIL (%s)\n' "$fails" >&2; exit 1
fi

# ---- real run --------------------------------------------------------------
oqa_require opencode curl jq node || exit 1

REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
[ -f "$REPO_ROOT/dist/index.js" ] || { oqa_log "no dist/index.js at $REPO_ROOT - run 'bun run build' first"; exit 1; }

REAL_DB="$(oqa_db_path)"
REAL_DB_BEFORE="$(sqlite3 "$REAL_DB" 'SELECT count(*) FROM session' 2>/dev/null)"
oqa_log "REAL_DB_BEFORE=$REAL_DB_BEFORE"

# oqa_start_server always mints a FRESH sandbox, which would discard the config
# written above. This starts a server inside the sandbox that already exists.
oqa_start_server_in_sandbox() {
  local port pass
  port="$(oqa_free_port)"
  pass="oqa-${RANDOM}${RANDOM}"
  # cd into the sandbox project FIRST. The plugin resolves its config chain from the
  # directory opencode runs in (`input.directory` in create-plugin-module.ts), NOT
  # from the session's directory field. Serving from the repo checkout made the
  # plugin walk up to the operator's real ~/.omo/omo.jsonc - proven by the run
  # logging teamModeEnabled:true, a value that exists only there - so every sandbox
  # override was ignored and the run died on the operator's real agent model.
  cd "$OQA_PROJ" || return 1
  OPENCODE_SERVER_PASSWORD="$pass" opencode serve --port "$port" --hostname 127.0.0.1 \
    >"$XDG_STATE_HOME/serve.log" 2>&1 &
  OQA_SERVER_PID=$!
  disown "$OQA_SERVER_PID" 2>/dev/null || true
  export OQA_SERVER_PORT="$port"
  export OQA_SERVER_PASS="$pass"
  export OQA_SERVER_URL="http://127.0.0.1:$port"
  if ! oqa_wait_http "$OQA_SERVER_URL/global/health" "opencode:$pass" 30; then
    oqa_log "server failed to start; log follows:"
    cat "$XDG_STATE_HOME/serve.log" >&2 2>/dev/null || true
    return 1
  fi
}

# ORDER IS LOAD-BEARING: the sandbox and EVERY config file must exist before the
# server starts. opencode loads its config, and the plugin loads the OMO chain, ONCE
# at startup. Starting the server first and writing config afterwards leaves the run
# on the operator's real agent models, which surfaces as `Model not found:
# <vendor>/<agent>` and reads exactly like a config-path bug that is not there.
# oqa_start_server calls oqa_mk_isolated_xdg internally, so the sandbox is created
# here explicitly and the server is started at the END of setup.
oqa_mk_isolated_xdg || { oqa_log "could not create the sandbox"; exit 1; }
SANDBOX="$OQA_XDG_ROOT"
# oqa_cleanup rm -rf's the sandbox on EXIT. Post-mortem on a failed run therefore
# lands on the PREVIOUS run's directory, which reads as a stale-config bug that is
# not there. --keep-sandbox unregisters it so the evidence survives.
if [ "$KEEP_SANDBOX" = "1" ]; then
  OQA_TMPDIRS=()
  oqa_log "KEEP_SANDBOX=$SANDBOX"
fi

MOCK_PORT_N="$(oqa_free_port)"
MOCK_LOG_FILE="$SANDBOX/mock-requests.log"
SCRIPT_FILE="$SANDBOX/script.json"
cat >"$SCRIPT_FILE" <<'JSON'
[
  {
    "tool": "task",
    "when": "REPORT_BLOCKED_PROBE",
    "unless": "Task launched",
    "args": {
      "description": "blocked child",
      "prompt": "You cannot proceed. Call report_blocked immediately with reason 'probe: needs a deploy target' and needs 'which environment'.",
      "category": "quick",
      "run_in_background": true
    }
  },
  {
    "tool": "report_blocked",
    "when": "report_blocked",
    "unless": "parked",
    "args": { "reason": "probe: needs a deploy target", "needs": "which environment" }
  },
  { "text": "Parent standing by; deliberately NOT answering the child." }
]
JSON

MOCK_PORT="$MOCK_PORT_N" MOCK_SCRIPT_FILE="$SCRIPT_FILE" MOCK_LOG="$MOCK_LOG_FILE" \
  node "$SCRIPT_DIR/lib/mock-model.mjs" >"$SANDBOX/mock.out" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do grep -q MOCK_LISTENING "$SANDBOX/mock.out" 2>/dev/null && break; sleep 0.1; done
grep -q MOCK_LISTENING "$SANDBOX/mock.out" || { oqa_log "mock model never listened"; kill "$MOCK_PID" 2>/dev/null; exit 1; }

mkdir -p "$OQA_PROJ/.opencode" "$XDG_CONFIG_HOME/opencode"
cat >"$XDG_CONFIG_HOME/opencode/opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": ["file://$REPO_ROOT"],
  "provider": {
    "mockprov": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:$MOCK_PORT_N/v1", "apiKey": "not-needed" },
      "models": { "mock-model": { "name": "mock-model" } }
    }
  },
  "model": "mockprov/mock-model"
}
JSON

# The knobs under test. 60s reminder / 120s expiry keeps the run ~3 minutes.
#
# Every agent and category is pinned to the mock model as well. The top-level
# "model" is NOT enough: agents and categories carry their own model requirements,
# so the parent session resolved a real vendor model and the run died with
# `Model not found: onara/sisyphus` before a single tool was called. A leaked
# vendor model id is also the difference between a hermetic run and one that would
# try to reach the network.
AGENT_MODEL_JSON=""
for agent in sisyphus hephaestus prometheus oracle librarian explore multimodal-looker metis momus atlas sisyphus-junior; do
  AGENT_MODEL_JSON="$AGENT_MODEL_JSON\"$agent\": { \"model\": \"mockprov/mock-model\" },"
done
CATEGORY_MODEL_JSON=""
for category in visual-engineering ultrabrain deep artistry quick unspecified-low unspecified-high writing; do
  CATEGORY_MODEL_JSON="$CATEGORY_MODEL_JSON\"$category\": { \"model\": \"mockprov/mock-model\" },"
done
#
# PATH MATTERS: the plugin reads the unified OMO chain - <project>/.omo/omo.jsonc
# merged onto $HOME/.omo/omo.jsonc - with plugin settings under a "[opencode]"
# block. Two traps, both of which fail SILENTLY and leave the operator's real agent
# models in force:
#   1. .opencode/oh-my-opencode.jsonc is read by NOTHING but the migration engine.
#   2. the harness key is literally "[opencode]", WITH the square brackets
#      (loader.ts destructures `"[opencode]"`). A plain "opencode" key matches
#      nothing and is dropped without a warning.
mkdir -p "$OQA_PROJ/.omo" "$HOME/.omo"
cat >"$OQA_PROJ/.omo/omo.jsonc" <<JSON
{
  "[opencode]": {
    "background_task": {
      "blockedRewakeMs": $REWAKE_MS,
      "blockedExpiryMs": $EXPIRY_MS
    },
    "agents": { ${AGENT_MODEL_JSON%,} },
    "categories": { ${CATEGORY_MODEL_JSON%,} }
  }
}
JSON
cp "$OQA_PROJ/.omo/omo.jsonc" "$HOME/.omo/omo.jsonc"

# Prove the override actually landed BEFORE spending three minutes on timers. Two
# separate runs were lost to a config written to a path/key the loader ignores, and
# both looked like "the reminder never fired" rather than "the config never applied".
if ! grep -q '"\[opencode\]"' "$OQA_PROJ/.omo/omo.jsonc"; then
  oqa_log "FAIL: harness block key must be the literal \"[opencode]\""; exit 1
fi
if ! grep -q "mockprov/mock-model" "$OQA_PROJ/.omo/omo.jsonc"; then
  oqa_log "FAIL: agent/category model pins missing from the sandbox config"; exit 1
fi

oqa_start_server_in_sandbox || { oqa_log "server did not start"; exit 1; }

# The plugin logs to os.tmpdir(), OUTSIDE the sandbox, so its startup line is the
# one place that proves WHICH directory it resolved config from. Six runs were lost
# to a server whose plugin silently used the operator's real config. The line is
# only written when the plugin actually loads, which happens on the first session
# rather than at server boot, so this is asserted after the session exists - and
# only against lines newer than this run, since a stale line from a previous run
# would otherwise answer for it.
PLUGIN_LOG="${TMPDIR:-/tmp}/oh-my-opencode.log"
PLUGIN_LOG_LINES_BEFORE=0
[ -f "$PLUGIN_LOG" ] && PLUGIN_LOG_LINES_BEFORE="$(wc -l <"$PLUGIN_LOG" | tr -d ' ')"

assert_plugin_used_sandbox() {
  # The plugin loads on the first PROMPT, not at server boot or session creation,
  # so this polls rather than reading once.
  local entry="" deadline
  deadline=$(( $(date +%s) + 30 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -f "$PLUGIN_LOG" ]; then
      entry="$(tail -n "+$((PLUGIN_LOG_LINES_BEFORE + 1))" "$PLUGIN_LOG" | grep -a "ENTRY - plugin loading" | tail -1)"
      [ -n "$entry" ] && break
    fi
    sleep 1
  done
  [ -n "$entry" ] || { oqa_log "FAIL: no plugin ENTRY line for THIS run - the plugin never loaded"; return 1; }
  printf '%s' "$entry" | grep -qF "$OQA_PROJ" && return 0
  oqa_log "FAIL: plugin loaded against the wrong directory:"
  printf '%s\n' "$entry" >&2
  return 1
}

AUTH="opencode:$OQA_SERVER_PASS"
SSE_FILE="$SANDBOX/events.sse"
curl -s -N -u "$AUTH" "$OQA_SERVER_URL/event" >"$SSE_FILE" 2>/dev/null &
OQA_CURL_PIDS+=($!)
sleep 1

SESSION_JSON="$(curl -s -u "$AUTH" -X POST "$OQA_SERVER_URL/session" \
  -H 'Content-Type: application/json' -d "{\"directory\":\"$OQA_PROJ\"}")"
PARENT_SESSION="$(printf '%s' "$SESSION_JSON" | jq -r '.id // empty')"
[ -n "$PARENT_SESSION" ] || { oqa_log "no parent session created: $SESSION_JSON"; exit 1; }
oqa_log "PARENT_SESSION=$PARENT_SESSION"



curl -s -u "$AUTH" -X POST "$OQA_SERVER_URL/session/$PARENT_SESSION/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"REPORT_BLOCKED_PROBE: delegate a background child that will report blocked."}]}' \
  >"$SANDBOX/parent-prompt.json" 2>&1 &
OQA_CURL_PIDS+=($!)

assert_plugin_used_sandbox || exit 1

# ---- watch the timeline ----------------------------------------------------
START="$(date +%s)"
BLOCKED_AT=""; REMINDER_AT=""; EXPIRY_AT=""
DEADLINE=$(( START + 260 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  # Fail fast on a PARENT session error, so the loop does not wait the full 260s for
  # timers that can never fire. Scoped to the parent and to non-abort errors on
  # purpose: parking a child ABORTS its session, so the child legitimately emits
  # MessageAbortedError as part of the flow under test. Treating any session.error
  # as fatal killed a run in which the feature was working correctly.
  if [ -z "$BLOCKED_AT" ] && grep -aq "\"sessionID\":\"$PARENT_SESSION\",\"error\"" "$SSE_FILE" 2>/dev/null \
     && ! grep -aq 'MessageAbortedError' "$SSE_FILE" 2>/dev/null; then
    oqa_log "FAIL: parent session.error before the child ever parked:"
    grep -ao "sessionID\":\"$PARENT_SESSION\",\"error.\{0,150\}" "$SSE_FILE" 2>/dev/null | head -2 >&2
    kill "$MOCK_PID" 2>/dev/null || true
    exit 1
  fi
  if [ -z "$BLOCKED_AT" ] && grep -q 'BACKGROUND TASK BLOCKED' "$SSE_FILE" 2>/dev/null; then
    BLOCKED_AT=$(( $(date +%s) - START )); oqa_log "observed: blocked wake at +${BLOCKED_AT}s"
  fi
  if [ -z "$REMINDER_AT" ] && grep -q 'reminder 1 of 1, waiting' "$SSE_FILE" 2>/dev/null; then
    REMINDER_AT=$(( $(date +%s) - START )); oqa_log "observed: reminder at +${REMINDER_AT}s"
  fi
  # Expiry is observed in the PLUGIN log, not the SSE stream. Unlike failBlockedTask,
  # expireBlockedTask notifies nobody: it mutates the task and schedules removal
  # without markForNotification/enqueueNotificationForParent, so no wake and no
  # session event ever reaches the parent. Watching SSE for it waits forever.
  if [ -z "$EXPIRY_AT" ] && [ -f "$PLUGIN_LOG" ] \
     && tail -n "+$((PLUGIN_LOG_LINES_BEFORE + 1))" "$PLUGIN_LOG" | grep -aq 'Blocked task expired unanswered'; then
    EXPIRY_AT=$(( $(date +%s) - START )); oqa_log "observed: expiry at +${EXPIRY_AT}s"
    break
  fi
  sleep 2
done

SANDBOX_DB="$XDG_DATA_HOME/opencode/opencode.db"
REMINDER_COUNT="$(grep -c 'reminder 1 of 1' "$SSE_FILE" 2>/dev/null || printf '0')"
CHILD_SESSION="$(grep -o 'ses_[A-Za-z0-9]*' "$SSE_FILE" 2>/dev/null | sort -u | grep -v "$PARENT_SESSION" | head -1)"

REAL_DB_AFTER="$(sqlite3 "$REAL_DB" 'SELECT count(*) FROM session' 2>/dev/null)"

# ---- verdict ---------------------------------------------------------------
fails=0
[ -n "$BLOCKED_AT" ]  || { oqa_log "FAIL: no blocked wake observed"; fails=$((fails+1)); }
[ -n "$REMINDER_AT" ] || { oqa_log "FAIL: no reminder wake observed"; fails=$((fails+1)); }
[ -n "$EXPIRY_AT" ]   || { oqa_log "FAIL: task never expired"; fails=$((fails+1)); }
[ "$REMINDER_COUNT" = "1" ] || { oqa_log "FAIL: expected exactly 1 reminder, saw $REMINDER_COUNT"; fails=$((fails+1)); }
if [ -n "$REMINDER_AT" ] && [ "$REMINDER_AT" -lt 45 ]; then
  oqa_log "FAIL: reminder fired at +${REMINDER_AT}s, far below the ${REWAKE_MS}ms deadline"; fails=$((fails+1))
fi
if [ -n "$EXPIRY_AT" ] && [ -n "$REMINDER_AT" ] && [ "$EXPIRY_AT" -le "$REMINDER_AT" ]; then
  oqa_log "FAIL: expiry (+${EXPIRY_AT}s) did not follow the reminder (+${REMINDER_AT}s)"; fails=$((fails+1))
fi

{
  printf 'REWAKE_MS=%s\n' "$REWAKE_MS"
  printf 'EXPIRY_MS=%s\n' "$EXPIRY_MS"
  printf 'PARENT_SESSION=%s\n' "$PARENT_SESSION"
  printf 'CHILD_SESSION=%s\n' "$CHILD_SESSION"
  printf 'BLOCKED_AT_S=%s\n' "${BLOCKED_AT:-none}"
  printf 'REMINDER_AT_S=%s\n' "${REMINDER_AT:-none}"
  printf 'EXPIRY_AT_S=%s\n' "${EXPIRY_AT:-none}"
  printf 'REMINDER_COUNT=%s\n' "$REMINDER_COUNT"
  printf 'REAL_DB_BEFORE=%s\n' "$REAL_DB_BEFORE"
  printf 'REAL_DB_AFTER=%s\n' "$REAL_DB_AFTER"
  printf 'REAL_DB_COUNT_NOTE=%s\n' "count may move if the operator uses opencode during the run; identity check below is authoritative"
  printf 'PARENT_IN_REAL_DB=%s\n' "$(sqlite3 "$REAL_DB" "SELECT count(*) FROM session WHERE id='$(oqa_sql_escape "$PARENT_SESSION")'" 2>/dev/null)"
  printf 'CHILD_IN_REAL_DB=%s\n' "$([ -n "$CHILD_SESSION" ] && sqlite3 "$REAL_DB" "SELECT count(*) FROM session WHERE id='$(oqa_sql_escape "$CHILD_SESSION")'" 2>/dev/null || printf 'n/a')"
  printf 'OPENCODE_VERSION=%s\n' "$(opencode --version 2>/dev/null | head -1)"
} >"$SANDBOX/run-metadata.txt"

# Isolation is asserted by SESSION IDENTITY, not by a session COUNT. A raw count
# also moves when the operator is using opencode in another window during the run,
# which reports leakage that is not there. What actually matters is that no session
# this probe created exists in the real DB.
LEAKED=0
for sid in "$PARENT_SESSION" "$CHILD_SESSION"; do
  [ -n "$sid" ] || continue
  found="$(sqlite3 "$REAL_DB" "SELECT count(*) FROM session WHERE id='$(oqa_sql_escape "$sid")'" 2>/dev/null)"
  [ "$found" = "0" ] || { oqa_log "FAIL: sandbox session $sid leaked into the real DB"; LEAKED=1; }
done
[ "$LEAKED" = "0" ] || fails=$((fails+1))

if [ -n "$EVIDENCE_DIR" ]; then
  mkdir -p "$EVIDENCE_DIR"
  cp "$SANDBOX/run-metadata.txt" "$EVIDENCE_DIR/escalation-run-metadata.txt" 2>/dev/null || true
  grep -a 'BACKGROUND TASK BLOCKED\|reminder 1 of 1\|expired unanswered' "$SSE_FILE" >"$EVIDENCE_DIR/escalation-wakes.txt" 2>/dev/null || true
  cp "$SANDBOX/mock-requests.log" "$EVIDENCE_DIR/escalation-mock-requests.log" 2>/dev/null || true
  [ -f "$SANDBOX_DB" ] && sqlite3 "$SANDBOX_DB" 'SELECT count(*) FROM session' >"$EVIDENCE_DIR/escalation-sandbox-session-count.txt" 2>/dev/null || true
fi

cat "$SANDBOX/run-metadata.txt"
kill "$MOCK_PID" 2>/dev/null || true

if [ "$fails" = "0" ]; then printf '\nESCALATION PROBE PASS\n'; exit 0; fi
printf '\nESCALATION PROBE FAIL (%s)\n' "$fails" >&2
exit 1
