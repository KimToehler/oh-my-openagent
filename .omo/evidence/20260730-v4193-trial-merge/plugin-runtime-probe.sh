#!/usr/bin/env bash
# plugin-runtime-probe.sh - prove the MERGED plugin survives a real TUI boot and
# a real model turn, not merely plugin init.
#
# plugin-load-probe.sh proved the plugin LOADS and registers agents. The bundled
# tui-smoke.sh proves the TUI renders, but against a BARE server with no plugin.
# Neither exercises the plugin at runtime. The v4.19.x state reverted earlier
# "broke the plugin's behaviour", which is a RUNTIME property, so this probe
# closes that gap:
#
#   A. TUI boots with the merged plugin loaded (tmux), renders, accepts keys.
#   B. A real session prompt runs end to end with the plugin in the loop, and
#      mid-turn lifecycle events appear on the SSE wire -> the hooks that
#      observe them (chat.message, tool.execute.*, event) would have fired.
#
# Isolation: own XDG_{DATA,CONFIG,STATE,CACHE}_HOME under a mktemp dir. The real
# ~/.local/share/opencode/opencode.db is never opened. Asserted before/after.
#
# A real turn needs a working provider credential. Pass --with-credentials to
# copy the host's opencode auth.json and its provider block into the sandbox so
# the turn can actually complete. Without that flag the turn half still runs but
# fails at model resolution, and is reported as such rather than faked.
#
# --with-credentials copies real secrets into the throwaway sandbox. They are
# never printed and the sandbox is rm -rf'd on exit. DB isolation is unaffected
# and still asserted: only auth + provider config are shared, never XDG_DATA_HOME.
set -uo pipefail

WITH_CREDS=""
[ "${1:-}" = "--with-credentials" ] && WITH_CREDS=1

WT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PLUGIN="$WT_ROOT/dist/index.js"

[ -f "$PLUGIN" ] || { echo "FAIL: no built plugin at $PLUGIN"; exit 1; }
for b in opencode jq tmux curl; do
  command -v "$b" >/dev/null || { echo "FAIL: missing dependency: $b"; exit 1; }
done

REAL_DB="$HOME/.local/share/opencode/opencode.db"
db_count() { sqlite3 "$REAL_DB" "SELECT count(*) FROM session;" 2>/dev/null || echo "unreadable"; }
DB_BEFORE="$(db_count)"

SANDBOX="$(mktemp -d -t oqa-plugin-runtime.XXXXXX)"
export XDG_DATA_HOME="$SANDBOX/data"
export XDG_CONFIG_HOME="$SANDBOX/config"
export XDG_STATE_HOME="$SANDBOX/state"
export XDG_CACHE_HOME="$SANDBOX/cache"
export OPENCODE_DISABLE_AUTOUPDATE=1
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME/opencode" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"

PROJ="$SANDBOX/proj"
mkdir -p "$PROJ/.opencode"

HOST_AUTH="$HOME/.local/share/opencode/auth.json"
HOST_CONFIG="$HOME/.config/opencode/opencode.json"

# The onara router rejects the auth.json Personal Access Token ("Personal Access
# Tokens are not supported for this endpoint"). The working credential for it is
# ONARA_ROUTER_KEY from the environment, so prefer that when present and write it
# as the provider apiKey.
ONARA_KEY="${ONARA_ROUTER_KEY:-}"

if [ -n "$WITH_CREDS" ] && [ -f "$HOST_AUTH" ]; then
  # auth.json lives under XDG_DATA_HOME, which is the sandbox - copying it in
  # gives the sandbox its own private copy. The real DB is a sibling file we
  # never touch, and the count assertion below proves it.
  # Copy auth.json verbatim - do not try to outsmart opencode's credential
  # resolution here.
  #
  # Verified facts: both the auth.json onara key and ONARA_ROUTER_KEY work
  # directly against https://router.onara.eu/v1/messages (HTTP 200, via
  # x-api-key and via Authorization: Bearer). So the credential is valid and the
  # router is reachable from this machine.
  #
  # Unresolved: inside the sandbox the turn still fails with "checking
  # third-party user token: Personal Access Tokens are not supported for this
  # endpoint". Four variants were tried - PAT from auth.json, ONARA_ROUTER_KEY as
  # provider apiKey, deleting the onara auth entry, deleting the anthropic OAuth
  # entry - all produced the identical error. Since `onara` declares
  # npm "@ai-sdk/anthropic", the credential opencode actually presents to the
  # router is resolved by machinery this probe does not control, and guessing
  # further is out of scope for a merge trial.
  #
  # This is a SANDBOX PLUMBING limitation, not a v4.19.3 finding: the same
  # config on the host works, and nothing in the failure path is plugin-owned
  # (it fails in SessionPrompt/provider auth, downstream of plugin init, with
  # zero plugin errors logged).
  mkdir -p "$XDG_DATA_HOME/opencode"
  cp "$HOST_AUTH" "$XDG_DATA_HOME/opencode/auth.json"
  chmod 600 "$XDG_DATA_HOME/opencode/auth.json"
  # A credential alone is not enough: `onara` is a custom provider, so its
  # provider block (npm + baseURL + models) must come along or model resolution
  # still fails. Merge the host provider map into the sandbox project config.
  if [ -f "$HOST_CONFIG" ] && jq -e '.provider' "$HOST_CONFIG" >/dev/null 2>&1; then
    if [ -n "$ONARA_KEY" ]; then
      jq --arg p "$PLUGIN" --arg k "$ONARA_KEY" \
        '{plugin: [$p], provider: (.provider | .onara.options.apiKey = $k), model: (.model // empty)}' \
        "$HOST_CONFIG" > "$PROJ/opencode.json" 2>/dev/null \
        || printf '{"plugin":["%s"]}\n' "$PLUGIN" > "$PROJ/opencode.json"
      echo "credentials: injected (auth.json + provider block + ONARA_ROUTER_KEY as apiKey)"
    else
      jq --arg p "$PLUGIN" '{plugin: [$p], provider: .provider, model: (.model // empty)}' \
        "$HOST_CONFIG" > "$PROJ/opencode.json" 2>/dev/null \
        || printf '{"plugin":["%s"]}\n' "$PLUGIN" > "$PROJ/opencode.json"
      echo "credentials: injected (auth.json + provider block; no ONARA_ROUTER_KEY in env)"
    fi
  else
    printf '{"plugin":["%s"]}\n' "$PLUGIN" > "$PROJ/opencode.json"
    echo "credentials: auth.json injected, no provider block found"
  fi
else
  printf '{"plugin":["%s"]}\n' "$PLUGIN" > "$PROJ/opencode.json"
  [ -n "$WITH_CREDS" ] && echo "credentials: requested but $HOST_AUTH not found" \
                       || echo "credentials: not injected (pass --with-credentials)"
fi

TMUX_SESSION="oqa-plugin-tui-$$"
SERVER_PID=""
cleanup() {
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null
  [ -n "$SERVER_PID" ] && { kill "$SERVER_PID" 2>/dev/null; sleep 0.3; kill -9 "$SERVER_PID" 2>/dev/null; }
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

fails=0

# ---------------------------------------------------------------- A. TUI boot
echo "=== A. TUI with merged plugin loaded ==="
tmux new-session -d -s "$TMUX_SESSION" -x 200 -y 50 -c "$PROJ" "opencode" 2>/dev/null
booted=""
for _ in $(seq 1 45); do
  sleep 1
  pane="$(tmux capture-pane -p -t "$TMUX_SESSION" 2>/dev/null)"
  printf '%s' "$pane" | grep -qiE "opencode|/help|ctrl" && { booted=1; break; }
done

if [ -n "$booted" ]; then
  echo "PASS: TUI booted and rendered WITH the merged plugin loaded"
else
  echo "FAIL: TUI did not render with plugin loaded"
  tmux capture-pane -p -t "$TMUX_SESSION" 2>/dev/null | tail -25
  fails=$((fails+1))
fi

PANE="$(tmux capture-pane -p -t "$TMUX_SESSION" 2>/dev/null)"
if printf '%s' "$PANE" | grep -qiE "error|failed to load|cannot find module|exception"; then
  echo "FAIL: TUI surface shows an error with the plugin loaded:"
  printf '%s' "$PANE" | grep -iE "error|failed to load|cannot find module|exception" | head -5
  fails=$((fails+1))
else
  echo "PASS: no plugin error surfaced in the TUI"
fi

SENTINEL="oqa-sentinel-$$"
tmux send-keys -t "$TMUX_SESSION" "$SENTINEL" 2>/dev/null
sleep 3
if tmux capture-pane -p -t "$TMUX_SESSION" 2>/dev/null | grep -q "$SENTINEL"; then
  echo "PASS: TUI composer accepted input with the plugin loaded"
else
  echo "FAIL: composer did not echo sentinel"
  fails=$((fails+1))
fi
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null

# ------------------------------------------------------- B. real model turn
echo
echo "=== B. real model turn with merged plugin in the loop ==="
PORT="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})' 2>/dev/null || echo 47411)"
PASS_TOKEN="probe-${RANDOM}${RANDOM}"
AUTH="opencode:$PASS_TOKEN"
URL="http://127.0.0.1:$PORT"
LOG="$XDG_STATE_HOME/serve.log"

cd "$PROJ" || exit 1
OPENCODE_SERVER_PASSWORD="$PASS_TOKEN" opencode serve --port "$PORT" --hostname 127.0.0.1 >"$LOG" 2>&1 &
SERVER_PID=$!
ready=""
for _ in $(seq 1 60); do
  curl -sf -u "$AUTH" "$URL/global/health" >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
[ -n "$ready" ] || { echo "FAIL: server with plugin did not start"; tail -30 "$LOG"; exit 1; }

SES="$(curl -s -u "$AUTH" -X POST -H 'Content-Type: application/json' \
  -d '{}' "$URL/session?directory=$PROJ" 2>/dev/null | jq -r '.id // empty')"
if [ -z "$SES" ]; then
  echo "FAIL: could not create a session"
  fails=$((fails+1))
else
  echo "PASS: session created ($SES)"

  EV="$(mktemp -t oqa-ev.XXXXXX)"
  curl -sN -u "$AUTH" "$URL/event?directory=$PROJ" >"$EV" 2>/dev/null &
  EVPID=$!
  sleep 2

  curl -s -u "$AUTH" -X POST -H 'Content-Type: application/json' \
    -d '{"parts":[{"type":"text","text":"Reply with exactly: PROBE_OK"}]}' \
    "$URL/session/$SES/prompt_async?directory=$PROJ" >/dev/null 2>&1

  seen=""
  for _ in $(seq 1 90); do
    sleep 1
    grep -qE "message\.part\.(updated|delta)|message\.updated|session\.idle" "$EV" 2>/dev/null && { seen=1; break; }
  done
  # let the turn settle so a completed reply lands before we assert on it
  sleep 5
  kill "$EVPID" 2>/dev/null

  if [ -n "$seen" ]; then
    echo "PASS: real turn produced mid-turn lifecycle events on the wire"
    grep -oE '"type":"[a-z.]+"' "$EV" 2>/dev/null | sort -u | head -14
  else
    echo "FAIL: no turn events observed within 90s"
    tail -12 "$LOG"
    fails=$((fails+1))
  fi

  # Did the turn actually COMPLETE, or die at model resolution? Event presence
  # alone only proves hooks were reachable; this distinguishes the two.
  if grep -q '"type":"session.error"' "$EV" 2>/dev/null; then
    echo "OBSERVED: session.error on the wire - extracting cause"
    grep -oE '"message":"[^"]{0,160}"' "$EV" 2>/dev/null | sort -u | head -4
    if grep -q 'Model not found' "$EV" 2>/dev/null; then
      echo "FAIL: model resolution failed - credentials/provider not effective in sandbox"
      fails=$((fails+1))
    else
      echo "FAIL: session.error for a non-credential reason - inspect above"
      fails=$((fails+1))
    fi
  else
    echo "PASS: no session.error - turn ran without erroring"
  fi

  # Assert the assistant actually replied with our sentinel.
  MSGS="$(curl -s -u "$AUTH" "$URL/session/$SES/message?directory=$PROJ" 2>/dev/null)"
  REPLY="$(printf '%s' "$MSGS" | jq -r '[.[] | select(.info.role=="assistant")] | last | .parts[]? | select(.type=="text") | .text' 2>/dev/null | tr -d '\n')"
  if printf '%s' "$REPLY" | grep -q "PROBE_OK"; then
    echo "PASS: assistant completed a real reply containing PROBE_OK"
  elif [ -n "$REPLY" ]; then
    echo "PASS: assistant produced a completed reply (sentinel not echoed verbatim)"
    printf '%s' "$REPLY" | head -c 160; echo
  else
    echo "FAIL: no assistant text part - the turn never completed"
    fails=$((fails+1))
  fi
  rm -f "$EV"
fi

if grep -qiE "failed to load plugin|cannot find module|plugin.*error" "$LOG"; then
  echo "FAIL: plugin errors during the runtime probe:"
  grep -iE "failed to load plugin|cannot find module|plugin.*error" "$LOG" | head -8
  fails=$((fails+1))
else
  echo "PASS: no plugin errors during the runtime probe"
fi

DB_AFTER="$(db_count)"
echo
echo "real DB sessions before=$DB_BEFORE after=$DB_AFTER"
if [ "$DB_BEFORE" = "$DB_AFTER" ]; then
  echo "PASS: real opencode DB untouched"
else
  echo "FAIL: real DB session count changed - ISOLATION BREACH"
  fails=$((fails+1))
fi

[ "$fails" -eq 0 ] && echo "PASS: plugin-runtime-probe" || echo "FAIL: plugin-runtime-probe ($fails checks failed)"
exit "$fails"
