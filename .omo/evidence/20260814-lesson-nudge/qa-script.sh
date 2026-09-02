set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
. .agents/skills/opencode-qa/scripts/lib/common.sh   # oqa_start_server, oqa_mk_isolated_xdg, oqa_cleanup (EXIT trap)
oqa_require opencode curl jq node sqlite3 || exit 1   # sqlite3 used by the isolation proof

REAL_HOME="$HOME"
EVID="$PWD/.omo/evidence/20260814-lesson-nudge"; mkdir -p "$EVID"   # absolute: the serve helper cd's
ls -la "$REAL_HOME/.omo/rules" > "$EVID/real-user-rules-before.txt" 2>&1 || true
sqlite3 "$REAL_HOME/.local/share/opencode/opencode.db" "SELECT count(*) FROM session;" \
  > "$EVID/session-count-before.txt" 2>/dev/null || echo "no real db" > "$EVID/session-count-before.txt"
REPO_ROOT="$PWD"
LOG="${TMPDIR:-/tmp}/oh-my-opencode.log"
# stat is BSD on macOS, GNU on Linux. Trying only one form degrades to none=none
# on the other platform and the rotation guard then passes vacuously.
log_inode() { stat -f %i "$LOG" 2>/dev/null || stat -c %i "$LOG" 2>/dev/null || echo absent; }
touch "$LOG"   # so the before-value is a real inode, not "absent" -> spurious RERUN
LOG_INODE_BEFORE="$(log_inode)"

# The nudge text length, derived from the SOURCE so the assertion cannot drift.
NUDGE_LEN="$(bun -e 'import {buildLessonNudgeMessage} from "./packages/omo-opencode/src/hooks/lesson-nudge/message"; process.stdout.write(String(buildLessonNudgeMessage().length))')"
echo "nudge length: $NUDGE_LEN" | tee "$EVID/nudge-length.txt"

# Slice the log by SESSION ID only. Session ids are unique per run, so this is
# immune to rotation and to other processes writing to the shared log (A-14).
# -a on both: the plugin log is 45+ MB and shared with the operator's other
# opencode processes. One stray byte makes grep classify it as binary and every
# count silently returns 0, which would read as "the nudge never fired".
count_log() { grep -aF "$2" "$LOG" 2>/dev/null | grep -acF "$1" || true; }
# Poll for an expected count instead of a fixed sleep; returns when satisfied or times out.
wait_for() { # wait_for <needle> <sid> <expected> <timeout-s>
  local t=0; while [ "$t" -lt "$4" ]; do
    [ "$(count_log "$1" "$2")" -ge "$3" ] && return 0; sleep 1; t=$((t+1)); done; return 1
}
# -f so a 4xx/5xx is a FAILURE. Without it curl exits 0 on a rejected prompt and
# the run continues counting log lines for a turn that never happened.
# --max-time so a hung model cannot hang the whole run with no timeout.
prompt() { # prompt <session-id> <text>
  curl -sf --max-time 120 -o /dev/null -X POST -u "$AUTH" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg t "$2" '{parts:[{type:"text",text:$t}]}')" \
    "$URL/session/$1/message?directory=$OQA_PROJ" \
    || { echo "FAIL: prompt POST rejected or timed out for $1"; return 1; }
}

# ---- run_case <label> <lessons-json-or-empty> -------------------------------
# Boots an isolated sandbox, a REACHABLE mock model, registers the plugin under
# test, writes config INSIDE the sandbox, then starts one serve process.
#
# EVERY step self-guards with an explicit `|| return 1` and a DISTINCT message.
# `set -e` does NOT apply inside this function: it is the left operand of an
# `||` list at the call site, and POSIX suspends errexit for every command of an
# AND-OR list except the last. Verified empirically. Without these guards a dead
# mock or an unwritten config sails through and the run dies 30s later at S0 with
# the misleading "gate never engaged", hiding a setup failure as a product bug.
run_case() {
  local label="$1" lessons="$2" agents cats mock_port
  oqa_mk_isolated_xdg || { echo "FAIL[$label]: sandbox creation"; return 1; }

  # A-13: the mock must be REACHABLE, not merely running. Mint the port first and
  # pass it in; mock-model.mjs defaults to port 0 (OS-assigned) and the script has
  # no way to learn that port afterwards.
  mock_port="$(oqa_free_port)" || { echo "FAIL[$label]: no free port for mock"; return 1; }
  # MOCK_LOG records every request body (mock-model.mjs:146). It is the ONLY proof
  # that a model turn actually happened, which is what S3's "zero lines" claim
  # depends on: without it, a dead model and a working gate-off look identical.
  MOCK_REQ_LOG="$XDG_STATE_HOME/mock-requests.log"
  MOCK_PORT="$mock_port" MOCK_LOG="$MOCK_REQ_LOG" \
    node .agents/skills/opencode-qa/scripts/lib/mock-model.mjs \
    > "$XDG_STATE_HOME/mock.log" 2>&1 &
  MOCK_PID=$!; OQA_CURL_PIDS+=("$MOCK_PID")
  local t=0; until grep -q MOCK_LISTENING "$XDG_STATE_HOME/mock.log" 2>/dev/null; do
    sleep 0.2; t=$((t+1)); [ "$t" -gt 100 ] && { echo "FAIL[$label]: mock never listened"; return 1; }
  done

  agents=""; for a in sisyphus hephaestus prometheus oracle librarian explore multimodal-looker metis momus atlas sisyphus-junior; do
    agents="$agents\"$a\": { \"model\": \"mockprov/mock-model\" },"; done
  cats=""; for c in visual-engineering ultrabrain deep artistry quick unspecified-low unspecified-high writing; do
    cats="$cats\"$c\": { \"model\": \"mockprov/mock-model\" },"; done

  # opencode.json: registers THE PLUGIN UNDER TEST and DEFINES the mockprov
  # provider. Model pins alone do not register a provider, and the sandbox
  # XDG_CONFIG_HOME is a fresh mktemp dir with no config, while the repo has no
  # root opencode.json and no .opencode/plugin/, so there is no auto-discovery
  # fallback. Without this block nothing under test is ever loaded.
  mkdir -p "$XDG_CONFIG_HOME/opencode" || { echo "FAIL[$label]: mkdir config"; return 1; }
  cat > "$XDG_CONFIG_HOME/opencode/opencode.json" <<JSON || { echo "FAIL[$label]: write opencode.json"; return 1; }
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": ["file://$REPO_ROOT"],
  "provider": {
    "mockprov": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:$mock_port/v1", "apiKey": "not-needed" },
      "models": { "mock-model": { "name": "mock-model" } }
    }
  },
  "model": "mockprov/mock-model"
}
JSON

  # BRACKETED harness key (A-10), written into the sandbox HOME the helper just
  # exported (A-12). Agents and categories carry their own model requirements, so
  # a top-level "model" alone leaves them resolving real vendor models.
  mkdir -p "$HOME/.omo" || { echo "FAIL[$label]: mkdir omo"; return 1; }
  cat > "$HOME/.omo/omo.jsonc" <<JSON || { echo "FAIL[$label]: write omo.jsonc"; return 1; }
{ "[opencode]": { "model": "mockprov/mock-model",
    "agents": { ${agents%,} }, "categories": { ${cats%,} }$lessons } }
JSON

  opencode_serve_here || { echo "FAIL[$label]: serve did not become healthy"; return 1; }
}

# POSITIVE CONTROL - call AFTER the first prompt of each case, never at boot.
# Three facts, each verified rather than assumed (A-19):
#  - the marker is `[oh-my-openagent] ENTRY - plugin loading`, emitted with
#    `directory` at create-plugin-module.ts:165-167;
#  - it goes to the PLUGIN log, NOT the serve log. The plugin logger only ever
#    does appendFileSync to os.tmpdir()/oh-my-opencode.log (logger.ts:88-97) and
#    never writes a console stream. Committed evidence confirms serve stdout is
#    52 bytes containing only "opencode server listening on ...".
#  - it appears on the FIRST PROMPT, not at server boot.
# Scoped by per-case line offset AND by $OQA_PROJ, because the plugin log is
# SHARED with the operator's other opencode processes and each case gets a fresh
# proj dir, so CASE A's entry must not be able to answer for CASE B.
assert_plugin_loaded() { # assert_plugin_loaded <label>
  local entry="" t=0
  while [ "$t" -lt 30 ]; do
    entry="$(tail -n "+$((PLUGIN_LOG_LINES_BEFORE + 1))" "$LOG" 2>/dev/null \
             | grep -a "ENTRY - plugin loading" | grep -aF "$OQA_PROJ" | tail -1)"
    [ -n "$entry" ] && break
    sleep 1; t=$((t+1))
  done
  [ -n "$entry" ] || { echo "FAIL[$1]: no ENTRY line naming $OQA_PROJ - the plugin under test never loaded"; return 1; }
  printf '%s\n' "$entry" > "$EVID/plugin-loaded-$1.txt"
}

# Prove a MODEL TURN actually completed. The plugin-loaded control proves the
# plugin loaded; it does NOT prove a turn happened, and S3's entire claim is
# about what happens at the END of a turn. Asymmetry that makes this necessary:
# CASE A asserts ">=1" so a dead turn fails loudly, CASE B asserts "==0" so the
# same failure is SILENT.
assert_turn_happened() { # assert_turn_happened <label>
  [ -s "$MOCK_REQ_LOG" ] \
    || { echo "FAIL[$1]: no model request reached the mock - looked at nothing"; return 1; }
  # mock-model.mjs:146 appends "${body}\n---\n", so wc -l counts body lines plus
  # separators. Count the separators to get actual requests.
  grep -c '^---$' "$MOCK_REQ_LOG" > "$EVID/mock-requests-$1.txt" || true
}

# Wait for an assistant message, instead of a bare sleep.
# SHAPE NOTE, verified, do not "correct" this: GET /session/:id/message returns
# entries shaped { info, parts }, so role is at `.info.role`. Confirmed by
# injector.ts:103 (`message?.info.role === "user"`) and by lsp-e2e.sh:1582 which
# reads `entry.parts` off the same envelope. The SQLite `message.data` column
# stores a FLATTENED form with `role` at top level; that is a different
# representation and is NOT what this endpoint returns.
# Count only COMPLETED assistant turns. `time.completed` is OPTIONAL on
# AssistantMessage (@opencode-ai/sdk types.gen.d.ts:102-105), so the row appears
# when the turn STARTS. session.idle - which this whole feature hangs on - fires
# at turn END, so an existence check would count a turn that has not finished.
assistant_count() { # assistant_count <session-id>
  curl -s -u "$AUTH" "$URL/session/$1/message?directory=$OQA_PROJ" \
    | jq '[.[] | select(.info.role=="assistant" and (.info.time.completed // null) != null)] | length' 2>/dev/null \
    | tail -1 || echo 0
}
# MONOTONIC: waits for a turn count GREATER THAN a baseline taken before the
# prompt. A fixed ">= 1" check returns instantly from turn 1's stale message on
# every later prompt, which silently reduces prompts 2 and 3 to a bare sleep -
# the exact vacuity A-20 was written to remove, reappearing one prompt later.
wait_for_turn() { # wait_for_turn <session-id> <baseline> <timeout-s>
  local t=0 n
  while [ "$t" -lt "$3" ]; do
    n="$(assistant_count "$1")"
    [ "${n:-0}" -gt "$2" ] && return 0
    sleep 1; t=$((t+1))
  done
  echo "FAIL: no NEW completed assistant turn for $1 within ${3}s (baseline $2)"; return 1
}
# NOTE: oqa_start_server calls oqa_mk_isolated_xdg ITSELF and would create a
# SECOND sandbox, discarding everything written above. That is why serve is
# spawned directly here instead. Do not "simplify" this back to oqa_start_server.
opencode_serve_here() {
  local port pass; port="$(oqa_free_port)"; pass="oqa-${RANDOM}${RANDOM}"
  cd "$OQA_PROJ" || return 1   # the plugin resolves its config chain from the CWD
  OPENCODE_SERVER_PASSWORD="$pass" opencode serve --port "$port" --hostname 127.0.0.1 \
    > "$XDG_STATE_HOME/serve.log" 2>&1 &
  OQA_SERVER_PID=$!; disown "$OQA_SERVER_PID" 2>/dev/null || true
  export OQA_SERVER_URL="http://127.0.0.1:$port" OQA_SERVER_PASS="$pass"
  cd "$REPO_ROOT" || return 1
  oqa_wait_http "$OQA_SERVER_URL/global/health" "opencode:$pass" 30
}

# ============ CASE A: gate ON ============
PLUGIN_LOG_LINES_BEFORE="$(wc -l < "$LOG" 2>/dev/null | tr -d ' ' || echo 0)"
run_case gate-on ', "lessons": { "enabled": true, "nudge": true }' || { echo "FAIL: sandbox"; exit 1; }
URL="$OQA_SERVER_URL"; AUTH="opencode:$OQA_SERVER_PASS"
SID="$(curl -s -X POST -u "$AUTH" "$URL/session?directory=$OQA_PROJ" | jq -r '.id')"
echo "session: $SID" | tee "$EVID/session-id.txt"

# S0 - HARD gate assertion. Two independent checks so a silently-ignored config
# cannot make everything below vacuously true.
# Captured for the record only. GET /config returns OPENCODE's config, not the omo
# plugin config, so .lessons is null even on a healthy run. Deliberately NOT an
# assertion and NOT a warning: a warning that fires on every healthy run trains
# the operator to ignore warnings. The real gate proof is the [lesson-nudge] line.
curl -s -u "$AUTH" "$URL/config?directory=$OQA_PROJ" > "$EVID/resolved-config.json" || true
BASE="$(assistant_count "$SID")"; BASE="${BASE:-0}"
prompt "$SID" "Reply with the single word READY." || exit 1
# Controls FIRST, so a setup failure cannot masquerade as a gate failure.
assert_plugin_loaded gate-on || exit 1
wait_for_turn "$SID" "$BASE" 60 || exit 1
assert_turn_happened gate-on || exit 1
wait_for "[lesson-nudge] registered nudge" "$SID" 1 30 \
  || { echo "FAIL S0: plugin IS loaded and a turn DID complete, but no [lesson-nudge] line - the gate is off or the hook never ran"; exit 1; }
echo "S0 PASS" | tee "$EVID/s0-gate.txt"

# S1 - delivery. Assert BOTH the insertion count AND that its contentLength equals
# the nudge length, so an unrelated synthetic injection cannot satisfy this (M-2b).
BASE="$(assistant_count "$SID")"; BASE="${BASE:-0}"
prompt "$SID" "Quote verbatim any reminder text you were given about recording lessons. If there is none, say NONE." || exit 1
wait_for_turn "$SID" "$BASE" 60 || exit 1
wait_for "Inserted synthetic part" "$SID" 1 30 || { echo "FAIL S1: no insertion"; exit 1; }
INS2=$(count_log "Inserted synthetic part" "$SID")
# Anchor with the closing brace: contentLength is the LAST key in the emitted
# object (verified live: {"sessionID":"...","contentLength":71}), so an unanchored
# prefix match would let 2500 satisfy an expected 250.
# -a on both: the shared log is 45+ MB and one stray byte would make grep treat
# it as binary, silently returning 0 for every count.
MATCH2=$(grep -aF "$SID" "$LOG" | grep -aF "Inserted synthetic part" | grep -acF "\"contentLength\":$NUDGE_LEN}" || true)
echo "insertions=$INS2 matching_len=$MATCH2" | tee "$EVID/insert-count-after-prompt2.txt"
[ "$INS2" -eq 1 ] || { echo "FAIL S1: expected 1 insertion, got $INS2"; exit 1; }
[ "$MATCH2" -eq 1 ] || { echo "FAIL S1: insertion is not the nudge (contentLength != $NUDGE_LEN)"; exit 1; }

# S2 - non-redelivery AND non-reregistration.
BASE="$(assistant_count "$SID")"; BASE="${BASE:-0}"
prompt "$SID" "Quote verbatim any reminder text you were given about recording lessons. If there is none, say NONE." || exit 1
# Wait for a NEW completed turn past the baseline, then allow settle time. A bare
# sleep on a "==1" assertion is the same shape of vacuity as on a "==0" one.
wait_for_turn "$SID" "$BASE" 60 || exit 1
sleep 3
INS3=$(count_log "Inserted synthetic part" "$SID"); REG3=$(count_log "[lesson-nudge] registered nudge" "$SID")
echo "insertions=$INS3 registrations=$REG3" | tee "$EVID/insert-count-after-prompt3.txt"
[ "$INS3" -eq 1 ] || { echo "FAIL S2: nudge re-delivered ($INS3)"; exit 1; }
[ "$REG3" -eq 1 ] || { echo "FAIL S2: nudge re-registered ($REG3)"; exit 1; }

# ============ CASE B: default install, no lessons key ============
oqa_cleanup
# oqa_cleanup does NOT restore HOME (only oqa_mk_isolated_xdg sets it, at
# common.sh:83). Without this, $HOME still points at CASE A's DELETED sandbox,
# oqa_mk_isolated_xdg captures that as real_home, and oqa_preserve_home_opencode_bin
# silently no-ops - which breaks CASE B on any machine using the HOME-based
# opencode shim, surfacing as a misleading "serve did not become healthy".
HOME="$REAL_HOME"
PLUGIN_LOG_LINES_BEFORE="$(wc -l < "$LOG" 2>/dev/null | tr -d ' ' || echo 0)"
run_case default '' || { echo "FAIL: sandbox"; exit 1; }
URL="$OQA_SERVER_URL"; AUTH="opencode:$OQA_SERVER_PASS"
DSID="$(curl -s -X POST -u "$AUTH" "$URL/session?directory=$OQA_PROJ" | jq -r '.id')"
echo "default session: $DSID" | tee "$EVID/default-session-id.txt"
BASE="$(assistant_count "$DSID")"; BASE="${BASE:-0}"
prompt "$DSID" "Say OK and nothing else." || exit 1
# S3's POSITIVE CONTROLS for CASE B's OWN sandbox. CASE A's gates do not cover it.
assert_plugin_loaded default || exit 1
wait_for_turn "$DSID" "$BASE" 60 || exit 1
assert_turn_happened default || exit 1
BASE="$(assistant_count "$DSID")"; BASE="${BASE:-0}"
prompt "$DSID" "Quote verbatim any reminder text you were given about recording lessons. If there is none, say NONE." || exit 1
wait_for_turn "$DSID" "$BASE" 60 || exit 1
sleep 3
DREG=$(count_log "[lesson-nudge] registered nudge" "$DSID"); DINS=$(count_log "Inserted synthetic part" "$DSID")
echo "reg=$DREG ins=$DINS" | tee "$EVID/default-install-counts.txt"
# S3's positive control is the plugin-loaded assertion inside run_case for THIS
# sandbox. CASE A's gates do NOT cover CASE B: any CASE B setup failure that
# CASE A survived would also yield zero lines and report PASS. "We saw nothing"
# must be distinguishable from "we looked at nothing".
[ "$DREG" -eq 0 ] && [ "$DINS" -eq 0 ] || { echo "FAIL S3: default install did work: reg=$DREG ins=$DINS"; exit 1; }
echo "S3 PASS (plugin loaded, gate off, zero lines)" | tee -a "$EVID/default-install-counts.txt"

# ---- rotation + isolation proofs ----
LOG_INODE_AFTER="$(log_inode)"
[ "$LOG_INODE_BEFORE" = "$LOG_INODE_AFTER" ] \
  || { echo "FAIL: log rotated mid-run (inode $LOG_INODE_BEFORE -> $LOG_INODE_AFTER); counts unreliable, RERUN"; exit 1; }
ls -la "$REAL_HOME/.omo/rules" > "$EVID/real-user-rules-after.txt" 2>&1 || true
# Explicit guard, NOT `diff && echo`: on a real breach that AND-list returns
# nonzero, set -e fires, and the run dies silently looking like an unrelated
# crash instead of reporting the breach it exists to catch.
if diff "$EVID/real-user-rules-before.txt" "$EVID/real-user-rules-after.txt" > /dev/null; then
  echo "ISOLATION OK" | tee "$EVID/isolation.txt"
else
  echo "FAIL: ISOLATION BREACH - the real ~/.omo/rules changed" | tee "$EVID/isolation.txt"; exit 1
fi
sqlite3 "$REAL_HOME/.local/share/opencode/opencode.db" "SELECT count(*) FROM session;" \
  > "$EVID/session-count-after.txt" 2>/dev/null || cp "$EVID/session-count-before.txt" "$EVID/session-count-after.txt"
if diff "$EVID/session-count-before.txt" "$EVID/session-count-after.txt" > /dev/null; then
  echo "REAL DB UNCHANGED"
else
  echo "FAIL: the real opencode DB session count changed"; exit 1
fi
