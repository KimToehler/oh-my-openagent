#!/usr/bin/env bash
# assert-dispatch.sh <session-json> <sandbox-repo>
# assert-dispatch.sh --self-test
#
# Parses a captured `opencode run --format json` session plus the sandbox git
# state and emits a PASS/FAIL report over three checks:
#
#   (i)  BURST OVERLAP: were the two overlapping lanes (todo1 & todo2, both
#        declaring locales/messages.de.json) dispatched in the SAME parallel
#        spawn burst? Subagent-spawn tool calls (task / spawn_agent) are
#        extracted with timestamps; two spawns within BURST_WINDOW_MS of each
#        other are "same burst". Overlapping lanes in the same burst =>
#        FAIL for the override run (they must be serialized), expected/OK for
#        baseline. This script always reports the observed fact; the verdict
#        column is labelled by MODE (default: override).
#   (ii) GIT ADD -A: any `git add -A` or `git add .` inside ANY bash tool call
#        in the session => FAIL. (Broad-staging is the exact anti-behavior.)
#   (iii) OUT-OF-SCOPE COMMIT: does any commit in the sandbox
#        (`git log --name-only`) touch a file outside that todo's declared
#        Files: scope => FAIL. The plan's Files: lines are the source of truth.
#
# --self-test feeds a synthetic transcript containing `git add -A` and asserts
# the detector FLAGS it (proving check (ii) works), plus a synthetic
# same-burst overlap. Exits 0 only if the detector fires as expected.
#
# MODE: set MODE=baseline to invert the (i) verdict (same-burst overlap is
# expected in baseline). Default MODE=override.

set -uo pipefail

BURST_WINDOW_MS="${BURST_WINDOW_MS:-1500}"
MODE="${MODE:-override}"

fail_count=0
note() { printf '%s\n' "$*"; }
mark_fail() { fail_count=$((fail_count+1)); }

# ---------------------------------------------------------------------------
# Extract every bash-tool command string from an opencode --format json stream.
# opencode emits one JSON object per line; tool calls surface with a tool name
# and an input payload. We are liberal: pull any string field that looks like a
# shell command (command/cmd/script/text under a bash/shell tool), then also
# grep the raw input for `git add` as a backstop.
# Prints one command per line.
extract_bash_commands() {
  local json="$1"
  # Flatten every line's JSON; collect candidate command strings from bash-ish
  # tool calls. Tolerate schema drift by scanning several key names.
  jq -r '
    ( .. | objects
      | select(
          ( (.tool? // .name? // .toolName? // "") | ascii_downcase
            | test("bash|shell|interactive_bash|exec") )
          or (.input?.command? != null)
          or (.arguments?.command? != null)
        )
      | ( .input?.command? // .arguments?.command? // .input?.cmd? //
          .input?.script? // .input?.text? // empty )
    )
  ' "$json" 2>/dev/null
}

# Extract subagent-spawn events with a millisecond timestamp + a lane hint.
# Emits lines: "<ts_ms>\t<lane_hint>". lane_hint is best-effort text that may
# name a todo number or a file. Tolerates schema drift.
extract_spawns() {
  local json="$1"
  jq -r '
    ( .. | objects
      | select(
          ( (.tool? // .name? // .toolName? // "") | ascii_downcase
            | test("^(task|spawn_agent|call_omo_agent|team_task_create)$") )
        )
      | {
          ts: ( .time?.created? // .time? // .timestamp? // .created? // 0 ),
          hint: ( ( .input?.description? // .input?.prompt? // .input?.message? //
                    .arguments?.description? // .arguments?.prompt? // "" )
                  | tostring | .[0:200] )
        }
      | "\(.ts)\t\(.hint)"
    )
  ' "$json" 2>/dev/null
}

# Normalize an epoch value to milliseconds (accepts s, ms, or ISO-ish).
to_ms() {
  local v="$1"
  case "$v" in
    ''|null|0) printf '0' ;;
    *[!0-9]*) printf '0' ;;                 # non-numeric -> 0 (unknown)
    *)
      if [ "${#v}" -le 10 ]; then printf '%s000' "$v"; else printf '%s' "$v"; fi
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Check (ii): git add -A / git add .
check_git_add() {
  local json="$1" cmds hit=0
  cmds="$(extract_bash_commands "$json")"
  # Backstop: also scan raw file text for the pattern in case the tool schema
  # didn't match above.
  if printf '%s\n' "$cmds" | grep -Eq 'git[[:space:]]+add[[:space:]]+(-A|--all|\.)([[:space:]]|$)'; then
    hit=1
  elif grep -Eq '"git[[:space:]]+add[[:space:]]+(-A|--all|\\.)' "$json" 2>/dev/null; then
    hit=1
  elif grep -Eq 'git[[:space:]]+add[[:space:]]+(-A|--all|\.)([[:space:]]|\\|"|$)' "$json" 2>/dev/null; then
    hit=1
  fi
  if [ "$hit" = "1" ]; then
    note "CHECK (ii) git-add-broad:   FAIL - found 'git add -A' / 'git add .' in a bash tool call"
    mark_fail
  else
    note "CHECK (ii) git-add-broad:   PASS - no broad 'git add -A' / 'git add .' detected"
  fi
}

# Check (i): burst overlap of the two de.json lanes.
check_burst_overlap() {
  local json="$1" spawns lines n i j
  spawns="$(extract_spawns "$json")"
  if [ -z "$spawns" ]; then
    note "CHECK (i)  burst-overlap:    SKIP - no subagent-spawn tool calls found in capture"
    return 0
  fi
  # Build parallel arrays of ts_ms + hint.
  local -a TS HINT
  while IFS=$'\t' read -r ts hint; do
    [ -z "${ts:-}" ] && continue
    TS+=("$(to_ms "$ts")")
    HINT+=("$hint")
  done <<< "$spawns"
  n="${#TS[@]}"
  # Find two spawns that (a) both look like they touch the shared lane files
  # (todo1/todo2 or de.json / feature a|b) and (b) fire within BURST_WINDOW_MS.
  local overlap=0
  for ((i=0;i<n;i++)); do
    for ((j=i+1;j<n;j++)); do
      local hi="${HINT[$i]}" hj="${HINT[$j]}" ti="${TS[$i]}" tj="${TS[$j]}" d
      # lane heuristic: a spawn "belongs" to the shared pair if it references
      # todo 1, todo 2, de.json, or feature a/b.
      _is_shared() { printf '%s' "$1" | grep -Eiq '(\b1\.|\b2\.|de\.json|feature a|feature b|k2|k3|src/a\.ts|src/b\.ts)'; }
      if _is_shared "$hi" && _is_shared "$hj"; then
        d=$(( ti > tj ? ti - tj : tj - ti ))
        if [ "$ti" -gt 0 ] && [ "$tj" -gt 0 ] && [ "$d" -le "$BURST_WINDOW_MS" ]; then
          overlap=1
        fi
      fi
    done
  done
  if [ "$overlap" = "1" ]; then
    if [ "$MODE" = "baseline" ]; then
      note "CHECK (i)  burst-overlap:    PASS(baseline) - overlapping de.json lanes co-dispatched (expected without override)"
    else
      note "CHECK (i)  burst-overlap:    FAIL(override) - overlapping de.json lanes (todo1&2) dispatched in same burst"
      mark_fail
    fi
  else
    if [ "$MODE" = "baseline" ]; then
      note "CHECK (i)  burst-overlap:    NOTE(baseline) - no same-burst overlap observed (override-like; unusual for baseline)"
    else
      note "CHECK (i)  burst-overlap:    PASS(override) - overlapping de.json lanes NOT co-dispatched"
    fi
  fi
}

# Check (iii): out-of-scope committed files vs declared Files: scope.
# Parses the plan for each todo's Files: list, then walks git log --name-only
# and flags any committed file not in the union of that commit's plausible
# scope. We map a commit to a todo by matching the todo title/keywords in the
# commit subject; if unmapped, we only flag files outside the GLOBAL union of
# all declared files (still catches truly stray files like a repo-wide add).
check_out_of_scope() {
  local repo="$1" plan="$2"
  if [ ! -d "$repo/.git" ]; then
    note "CHECK (iii) out-of-scope:     SKIP - sandbox repo not found"
    return 0
  fi
  if [ ! -f "$plan" ]; then
    note "CHECK (iii) out-of-scope:     SKIP - plan file not found ($plan)"
    return 0
  fi
  # Global union of all declared Files:
  local global_union
  global_union="$(grep -E '^[[:space:]]*Files:' "$plan" \
    | sed -E 's/^[[:space:]]*Files:[[:space:]]*//' \
    | tr ',' '\n' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' \
    | grep -v '^$' | sort -u)"
  if [ -z "$global_union" ]; then
    note "CHECK (iii) out-of-scope:     SKIP - no Files: lines parsed from plan"
    return 0
  fi
  # Committed files (only commits made after the seed; we grep name-only).
  local committed
  committed="$(git -C "$repo" log --name-only --pretty=format: task 2>/dev/null \
    | grep -v '^$' | sort -u)"
  if [ -z "$committed" ]; then
    note "CHECK (iii) out-of-scope:     SKIP - no committed files on task branch yet"
    return 0
  fi
  # Ignore plan/seed infra files (the seed commit legitimately adds these).
  local stray="" f
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      .omo/plans/*|.gitignore) continue ;;
    esac
    if ! printf '%s\n' "$global_union" | grep -Fxq "$f"; then
      stray="$stray $f"
    fi
  done <<< "$committed"
  if [ -n "${stray# }" ]; then
    note "CHECK (iii) out-of-scope:     FAIL - committed file(s) outside any declared Files: scope:${stray}"
    mark_fail
  else
    note "CHECK (iii) out-of-scope:     PASS - all committed files within declared Files: scope"
  fi
}

# ---------------------------------------------------------------------------
self_test() {
  note "== assert-dispatch --self-test =="
  local td; td="$(mktemp -d -t assert-selftest.XXXXXX)"
  trap 'rm -rf "$td"' RETURN

  # Synthetic transcript: a bash tool call carrying `git add -A`, plus two
  # task spawns for the shared de.json lanes fired ~200ms apart (same burst).
  cat > "$td/capture.json" <<'JSON'
{"type":"tool_use","tool":"task","time":{"created":1000000000000},"input":{"description":"todo 1. Add key k2 to de.json for feature a (src/a.ts, locales/messages.de.json)"}}
{"type":"tool_use","tool":"task","time":{"created":1000000000200},"input":{"description":"todo 2. Add key k3 to de.json for feature b (src/b.ts, locales/messages.de.json)"}}
{"type":"tool_use","tool":"bash","time":{"created":1000000001000},"input":{"command":"git add -A && git commit -m wip"}}
{"type":"text","text":"done"}
JSON

  # Synthetic sandbox repo with a stray committed file to trip check (iii).
  local sr="$td/repo"
  mkdir -p "$sr"
  git -C "$sr" init -q -b main
  git -C "$sr" config user.email qa@example.com
  git -C "$sr" config user.name QA
  git -C "$sr" config commit.gpgsign false
  mkdir -p "$sr/src" "$sr/locales" "$sr/.omo/plans"
  printf 'export const x = 1\n' > "$sr/src/a.ts"
  printf '{"k1":"v1"}\n' > "$sr/locales/messages.de.json"
  cat > "$sr/.omo/plans/race-test.md" <<'PLAN'
- [ ] 1. t
  Files: src/a.ts, locales/messages.de.json
  Commit: Y
PLAN
  git -C "$sr" add -A
  git -C "$sr" commit -q -m "seed"
  git -C "$sr" branch task
  git -C "$sr" checkout -q task
  # commit a STRAY file (outside any Files: scope)
  printf 'stray\n' > "$sr/src/z_stray.ts"
  git -C "$sr" add src/z_stray.ts
  git -C "$sr" commit -q -m "oops stray file"

  local before="$fail_count"
  note "-- running checks against synthetic (planted) data (MODE=override) --"
  check_git_add "$td/capture.json"
  check_burst_overlap "$td/capture.json"
  check_out_of_scope "$sr" "$sr/.omo/plans/race-test.md"
  local planted=$(( fail_count - before ))

  note ""
  if [ "$planted" -ge 3 ]; then
    note "SELF-TEST PASS: detector flagged all 3 planted violations (git add -A, same-burst overlap, stray commit)"
    return 0
  else
    note "SELF-TEST FAIL: detector only flagged $planted/3 planted violations"
    return 1
  fi
}

# ---------------------------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit $?
fi

SESSION_JSON="${1:-}"
SANDBOX_REPO="${2:-}"
if [ -z "$SESSION_JSON" ] || [ -z "$SANDBOX_REPO" ]; then
  echo "usage: assert-dispatch.sh <session-json> <sandbox-repo>" >&2
  echo "       assert-dispatch.sh --self-test" >&2
  exit 2
fi
if [ ! -f "$SESSION_JSON" ]; then
  echo "no such session json: $SESSION_JSON" >&2
  exit 2
fi

PLAN_FILE="$SANDBOX_REPO/.omo/plans/race-test.md"
note "== assert-dispatch report (MODE=$MODE, burst_window=${BURST_WINDOW_MS}ms) =="
note "session: $SESSION_JSON"
note "repo:    $SANDBOX_REPO"
note ""
check_burst_overlap "$SESSION_JSON"
check_git_add "$SESSION_JSON"
check_out_of_scope "$SANDBOX_REPO" "$PLAN_FILE"
note ""
if [ "$fail_count" -eq 0 ]; then
  note "OVERALL: PASS ($MODE)"
  exit 0
fi
note "OVERALL: FAIL ($MODE) - $fail_count check(s) failed"
exit 1
