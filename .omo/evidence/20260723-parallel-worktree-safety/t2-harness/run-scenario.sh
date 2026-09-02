#!/usr/bin/env bash
# run-scenario.sh [--with-override] <sandbox-repo>
#
# Runs ONE start-work proof pass against an isolated opencode.
#
#   * Sources the repo's script/agent/qa-sandbox.sh so every XDG_* dir and
#     CODEX_HOME land under a fresh mktemp tree. The host ~/.config/opencode and
#     ~/.local/share/opencode are NEVER read or written by the spawned opencode.
#   * Copies the user's REAL provider auth (~/.local/share/opencode/auth.json)
#     into the isolated XDG_DATA_HOME so a real model actually runs.
#   * Registers the OmO plugin + agent/model config into the isolated
#     XDG_CONFIG_HOME/opencode so `start work` (the start-work skill) exists.
#   * With --with-override, ALSO copies the user's real
#     ~/.config/opencode/skills/{start-work,ulw-plan} into the isolated
#     skills dir (READ-ONLY copy). Without it: baseline, no override skills.
#   * cd into the sandbox repo and run:
#       opencode run --format json "start work on the race-test plan"
#     capturing full stdout JSON to a file, whose path is printed.
#
# Prints CAPTURE=<path> on success.
#
# NOTE: this script deliberately does NOT `set -e` around the opencode run so a
# model/auth failure still yields a capture file + a clear message.

set -uo pipefail

WITH_OVERRIDE=0
SANDBOX_REPO=""
for arg in "$@"; do
  case "$arg" in
    --with-override) WITH_OVERRIDE=1 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) SANDBOX_REPO="$arg" ;;
  esac
done

if [ -z "$SANDBOX_REPO" ] || [ ! -d "$SANDBOX_REPO/.git" ]; then
  echo "usage: run-scenario.sh [--with-override] <sandbox-repo>" >&2
  echo "  <sandbox-repo> must be a git repo (from make-sandbox.sh)" >&2
  exit 2
fi

REPO_ROOT="/Users/tim/git/oh-my-openagent"
QA_SANDBOX="$REPO_ROOT/script/agent/qa-sandbox.sh"
REAL_XDG_CONFIG="${XDG_CONFIG_HOME_REAL:-$HOME/.config}"
REAL_XDG_DATA="${XDG_DATA_HOME_REAL:-$HOME/.local/share}"

if [ ! -f "$QA_SANDBOX" ]; then
  echo "[run-scenario] missing $QA_SANDBOX" >&2
  exit 1
fi

# Isolate FIRST (this rewrites XDG_* + CODEX_HOME under a fresh mktemp tree).
# shellcheck disable=SC1090
. "$QA_SANDBOX"

# qa-sandbox.sh exports OMO_QA_ROOT + isolated XDG_*; keep the sandbox offline.
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_MODELS_FETCH=1

ISO_CONFIG="$XDG_CONFIG_HOME/opencode"
ISO_DATA="$XDG_DATA_HOME/opencode"
mkdir -p "$ISO_CONFIG" "$ISO_DATA"

# 1) provider auth: copy real auth.json into isolated data dir so a real model runs.
if [ -f "$REAL_XDG_DATA/opencode/auth.json" ]; then
  cp "$REAL_XDG_DATA/opencode/auth.json" "$ISO_DATA/auth.json"
  echo "[run-scenario] copied provider auth into isolated data dir" >&2
else
  echo "[run-scenario] WARNING: no real auth.json found; opencode run will likely fail without a provider" >&2
fi

# 2) OmO plugin registration + agent/model config into the isolated opencode config.
#    Read the real plugin array + oh-my-openagent.json so the isolated run uses
#    the same plugin version + model routing. Fall back to a bare plugin entry.
PLUGIN_ARR='["oh-my-openagent"]'
if [ -f "$REAL_XDG_CONFIG/opencode/opencode.json" ]; then
  _p="$(jq -c '.plugin // ["oh-my-openagent"]' "$REAL_XDG_CONFIG/opencode/opencode.json" 2>/dev/null || true)"
  [ -n "$_p" ] && [ "$_p" != "null" ] && PLUGIN_ARR="$_p"
fi
jq -n --argjson plugin "$PLUGIN_ARR" \
  '{"$schema":"https://opencode.ai/config.json","instructions":[],"plugin":$plugin}' \
  > "$ISO_CONFIG/opencode.json"
echo "[run-scenario] registered plugin $PLUGIN_ARR in isolated opencode.json" >&2

if [ -f "$REAL_XDG_CONFIG/opencode/oh-my-openagent.json" ]; then
  cp "$REAL_XDG_CONFIG/opencode/oh-my-openagent.json" "$ISO_CONFIG/oh-my-openagent.json"
  echo "[run-scenario] copied oh-my-openagent.json (agent/model routing)" >&2
fi

# 3) skill override: only under --with-override, copy the real user skills in.
mkdir -p "$ISO_CONFIG/skills"
if [ "$WITH_OVERRIDE" = "1" ]; then
  copied=0
  for sk in start-work ulw-plan; do
    if [ -d "$REAL_XDG_CONFIG/opencode/skills/$sk" ]; then
      cp -R "$REAL_XDG_CONFIG/opencode/skills/$sk" "$ISO_CONFIG/skills/$sk"
      copied=$((copied+1))
    else
      echo "[run-scenario] WARNING: override skill missing: $REAL_XDG_CONFIG/opencode/skills/$sk" >&2
    fi
  done
  echo "[run-scenario] MODE=with-override (copied $copied override skill dir(s))" >&2
else
  echo "[run-scenario] MODE=baseline (no override skills copied)" >&2
fi

# 4) run the scenario from inside the sandbox repo, capturing full JSON stdout.
CAPTURE="$OMO_QA_ROOT/capture-$([ "$WITH_OVERRIDE" = 1 ] && echo override || echo baseline).json"
echo "[run-scenario] running opencode in $SANDBOX_REPO ..." >&2
(
  cd "$SANDBOX_REPO"
  opencode run --format json "start work on the race-test plan"
) > "$CAPTURE" 2>"$CAPTURE.stderr" || echo "[run-scenario] opencode run exited non-zero (see $CAPTURE.stderr)" >&2

echo "[run-scenario] isolated env root: $OMO_QA_ROOT (clean up: rm -rf \"$OMO_QA_ROOT\")" >&2
echo "CAPTURE=$CAPTURE"
