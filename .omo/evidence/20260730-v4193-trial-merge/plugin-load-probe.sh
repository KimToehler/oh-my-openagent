#!/usr/bin/env bash
# plugin-load-probe.sh - prove the MERGED plugin build actually loads in a real
# opencode server, in a fully isolated XDG sandbox.
#
# The bundled opencode-qa scripts boot a BARE server (no plugin), which proves
# opencode works but says nothing about our plugin. Last time a v4.19.x merge
# was pulled it "broke the plugin's behaviour" - a bare-server smoke would not
# have caught that. This probe closes that gap.
#
# Asserts, against a server that loaded dist/index.js as a plugin:
#   1. /global/health is healthy            -> server survived plugin load
#   2. /agent lists our canonical agents    -> config hook ran and registered
#   3. agent order is Sisyphus-first        -> installAgentSortShim() applied
#   4. serve.log has no plugin load error   -> no silent init failure
#
# Isolation: own XDG_{DATA,CONFIG,STATE,CACHE}_HOME under a mktemp dir. The real
# ~/.local/share/opencode/opencode.db is never opened.
set -uo pipefail

WT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PLUGIN="$WT_ROOT/dist/index.js"

[ -f "$PLUGIN" ] || { echo "FAIL: no built plugin at $PLUGIN"; exit 1; }
command -v opencode >/dev/null || { echo "FAIL: opencode not on PATH"; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq not on PATH"; exit 1; }

SANDBOX="$(mktemp -d -t oqa-plugin-probe.XXXXXX)"
export XDG_DATA_HOME="$SANDBOX/data"
export XDG_CONFIG_HOME="$SANDBOX/config"
export XDG_STATE_HOME="$SANDBOX/state"
export XDG_CACHE_HOME="$SANDBOX/cache"
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_MODELS_FETCH=1
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME/opencode" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"

PROJ="$SANDBOX/proj"
mkdir -p "$PROJ/.opencode"
# Register the MERGED build as a plugin for this isolated instance only.
printf '{"plugin":["%s"]}\n' "$PLUGIN" > "$PROJ/opencode.json"

SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && { kill "$SERVER_PID" 2>/dev/null; sleep 0.3; kill -9 "$SERVER_PID" 2>/dev/null; }
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

PORT="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})' 2>/dev/null || echo 47311)"
PASS="probe-${RANDOM}${RANDOM}"
AUTH="opencode:$PASS"
URL="http://127.0.0.1:$PORT"
LOG="$XDG_STATE_HOME/serve.log"

cd "$PROJ" || exit 1
OPENCODE_SERVER_PASSWORD="$PASS" opencode serve --port "$PORT" --hostname 127.0.0.1 >"$LOG" 2>&1 &
SERVER_PID=$!

ready=""
for _ in $(seq 1 60); do
  if curl -sf -u "$AUTH" "$URL/global/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done

fails=0
if [ -n "$ready" ]; then
  echo "PASS: server booted WITH plugin loaded ($URL)"
else
  echo "FAIL: server did not become ready with plugin loaded"
  echo "--- serve.log ---"; tail -40 "$LOG"
  exit 1
fi

AGENTS_JSON="$(curl -s -u "$AUTH" "$URL/agent?directory=$PROJ" 2>/dev/null)"
NAMES="$(printf '%s' "$AGENTS_JSON" | jq -r '.[].name' 2>/dev/null | tr '\n' ' ')"
echo "agents: $NAMES"

for want in sisyphus oracle explore librarian; do
  if printf '%s' "$NAMES" | grep -qi "$want"; then
    echo "PASS: plugin registered agent '$want'"
  else
    echo "FAIL: agent '$want' MISSING - plugin config hook did not register it"
    fails=$((fails+1))
  fi
done

FIRST="$(printf '%s' "$AGENTS_JSON" | jq -r '.[0].name' 2>/dev/null)"
if printf '%s' "$FIRST" | grep -qi sisyphus; then
  echo "PASS: canonical agent order intact (first=$FIRST)"
else
  echo "FAIL: canonical order broken (first=$FIRST, expected Sisyphus) - installAgentSortShim regression"
  fails=$((fails+1))
fi

if grep -qiE "failed to load plugin|plugin.*error|cannot find module" "$LOG"; then
  echo "FAIL: plugin load errors in serve.log:"
  grep -iE "failed to load plugin|plugin.*error|cannot find module" "$LOG" | head -10
  fails=$((fails+1))
else
  echo "PASS: no plugin load errors in serve.log"
fi

[ "$fails" -eq 0 ] && echo "PASS: plugin-load-probe" || echo "FAIL: plugin-load-probe ($fails checks failed)"
exit "$fails"
