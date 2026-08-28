#!/usr/bin/env bash
# QA isolation helper. SOURCE this file (do not execute it) to export a
# throwaway OpenCode + Codex environment so QA never reads or writes your real
# host config:
#
#   source script/agent/qa-sandbox.sh
#
# It mirrors the opencode-qa (oqa_mk_isolated_xdg) and codex-qa (isolated
# CODEX_HOME) skill conventions: every path lands under a fresh mktemp dir, so
# the running machine's ~/.config/opencode, ~/.codex, and ~/.omo are untouched.
# Remove the sandbox afterwards with: rm -rf "$OMO_QA_ROOT"
#
# HOME is redirected too, and that is load-bearing rather than tidiness: the
# plugin's own config chain is $HOME/.omo/omo.json[c], which is NOT an XDG path.
# Isolating only XDG_* leaves it resolving to the operator's real config, and a
# QA run that pins agent/category models to a mock then overwrites it. That is
# not hypothetical - it destroyed a real ~/.omo/omo.jsonc; see
# docs/troubleshooting/harness-findings.md (2026-08-28).
#
# Intentionally does NOT set -e: sourcing must not change the caller's shell.

OMO_QA_ROOT="$(mktemp -d -t omo-qa-sandbox.XXXXXX)"
export OMO_QA_ROOT

# OpenCode: isolated XDG dirs (never the host ~/.config or ~/.local/share).
export XDG_DATA_HOME="$OMO_QA_ROOT/data"
export XDG_CONFIG_HOME="$OMO_QA_ROOT/config"
export XDG_CACHE_HOME="$OMO_QA_ROOT/cache"
export XDG_STATE_HOME="$OMO_QA_ROOT/state"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_MODELS_FETCH=1

# Codex: isolated CODEX_HOME (must exist before codex runs, or it hard-errors).
export CODEX_HOME="$OMO_QA_ROOT/codex"
mkdir -p "$CODEX_HOME"

# OMO plugin config: $HOME/.omo/omo.json[c] is not an XDG path, so it is only
# isolated by moving HOME itself. Mirrors oqa_mk_isolated_xdg in
# .agents/skills/opencode-qa/scripts/lib/common.sh, including its relink of
# $HOME/.opencode/bin: some installed opencode wrappers resolve the real binary
# through that path and break once HOME moves.
_omo_real_home="$HOME"
export HOME="$OMO_QA_ROOT/home"
mkdir -p "$HOME"
if [ -d "$_omo_real_home/.opencode/bin" ]; then
  mkdir -p "$HOME/.opencode"
  ln -s "$_omo_real_home/.opencode/bin" "$HOME/.opencode/bin" 2>/dev/null || true
fi
unset _omo_real_home

# Credentials, set once: inject keys from the gitignored .env (see .env.example).
# ${BASH_SOURCE[0]:-$0} resolves this file under both bash and zsh (sourced $0).
_omo_self="${BASH_SOURCE[0]:-$0}"
_omo_repo_root="$(cd "$(dirname "$_omo_self")/../.." && pwd)"
if [ -f "$_omo_repo_root/.env" ]; then
  case "$-" in *a*) _omo_had_allexport=1 ;; *) _omo_had_allexport=0 ;; esac
  set -a
  # shellcheck disable=SC1091
  . "$_omo_repo_root/.env"
  [ "$_omo_had_allexport" = "1" ] || set +a
  unset _omo_had_allexport
fi
unset _omo_self _omo_repo_root

printf '[qa-sandbox] isolated env ready under %s\n' "$OMO_QA_ROOT"
printf '[qa-sandbox]   XDG_CONFIG_HOME=%s\n' "$XDG_CONFIG_HOME"
printf '[qa-sandbox]   CODEX_HOME=%s\n' "$CODEX_HOME"
printf '[qa-sandbox] host ~/.config/opencode and ~/.codex are untouched. Clean up: rm -rf "%s"\n' "$OMO_QA_ROOT"
