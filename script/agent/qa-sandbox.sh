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
# Moving HOME is necessary but NOT sufficient, so this also exports OMO_QA_PROJ
# and you MUST run QA from it. Project config layers are collected by walking cwd
# upward until $HOME and they OUTRANK the user layer, so from a cwd under your
# real home the walk still claims ~/.omo - as a project layer that beats the
# sandbox, and that the migration engine can write to. Isolation is complete only
# when both HOME and cwd sit inside the sandbox.
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
if [ -n "${OMO_QA_SANDBOX_ACTIVE:-}" ]; then
  # Re-sourcing in the same shell would relink the new sandbox against the
  # PREVIOUS sandbox home (already $HOME by then) and orphan the old root.
  printf '[qa-sandbox] already active under %s; not re-entering. Start a new shell to get a fresh sandbox.\n' "$OMO_QA_ROOT_ACTIVE"
else
  _omo_real_home="$HOME"
  export HOME="$OMO_QA_ROOT/home"
  # OPENCODE_TEST_HOME mirrors oqa_mk_isolated_xdg; some opencode paths read it
  # instead of HOME.
  export OPENCODE_TEST_HOME="$HOME"
  mkdir -p "$HOME"
  if [ -d "$_omo_real_home/.opencode/bin" ]; then
    mkdir -p "$HOME/.opencode"
    ln -s "$_omo_real_home/.opencode/bin" "$HOME/.opencode/bin" 2>/dev/null || true
  fi
  unset _omo_real_home
  export OMO_QA_SANDBOX_ACTIVE=1
  export OMO_QA_ROOT_ACTIVE="$OMO_QA_ROOT"
fi

# A sandbox project directory, and it is NOT cosmetic. The plugin's config chain
# is user layer ($HOME/.omo) PLUS project layers collected by walking cwd upward
# and stopping at $HOME (packages/omo-config-core/src/loader/paths.ts:75-101),
# where project layers WIN over the user layer. Moving HOME alone therefore does
# not isolate the operator's ~/.omo when cwd sits under the real home — which is
# this repo's own default layout. The walk sails past /Users/<you>/.omo and
# claims it as a project layer, so a QA run silently uses the operator's real
# agent/model pins, and the migration engine can WRITE there
# (config/migration/discovery-paths.ts uses the same boundary).
# Running from $OMO_QA_PROJ terminates that walk inside the sandbox on the first
# iteration. This is the other half of the isolation, and it is why
# oqa_mk_isolated_xdg creates $root/proj and exports OQA_PROJ.
export OMO_QA_PROJ="$OMO_QA_ROOT/proj"
mkdir -p "$OMO_QA_PROJ"

# Credentials, set once: inject keys from the gitignored .env (see .env.example).
# ${BASH_SOURCE[0]:-$0} resolves this file under both bash and zsh (sourced $0).
_omo_self="${BASH_SOURCE[0]:-$0}"
_omo_repo_root="$(cd "$(dirname "$_omo_self")/../.." && pwd)"

# Register THIS repo's built plugin, because a sandbox that isolates perfectly
# but loads no omo plugin is the worst QA surface there is: the server is
# healthy, sessions run, tools execute, and every omo hook is silently absent.
# A probe then reports "the hook did not fire", which reads as evidence about
# the feature when it is evidence about the harness. That inversion produced
# four INCONCLUSIVE verdicts on a vulnerability that reproduced immediately once
# the plugin was actually loaded (harness-findings.md, 2026-09-02).
#
# Three details are load-bearing:
#   - XDG, not $HOME/.config. Once XDG_CONFIG_HOME is exported, opencode reads
#     $XDG_CONFIG_HOME/opencode - so writing to $HOME/.config/opencode lands at
#     a path nothing reads. That mistake is what made the original report
#     conclude, wrongly, that only project-level registration works.
#   - .json, not .jsonc. A .jsonc in the same directory WINS outright, and the
#     probes each write their own .jsonc there. Using .json means a probe's own
#     config cleanly supersedes this default instead of half-merging with it.
#   - dist/index.js, the same path the probes use. Config levels MERGE rather
#     than override, so a second, differently-pathed omo entry (say src/index.ts)
#     loads omo TWICE - and detectDuplicateOmoPlugin() responds by disabling the
#     plugin entirely, recreating the very silence this exists to prevent.
#     Identical paths dedupe to one entry and are safe.
_omo_plugin_entry="$_omo_repo_root/dist/index.js"
mkdir -p "$XDG_CONFIG_HOME/opencode"
printf '{"plugin":["file://%s"]}\n' "$_omo_plugin_entry" > "$XDG_CONFIG_HOME/opencode/opencode.json"

# dist/ is a build artifact and nothing here guarantees it is present or current.
# Both failure modes are silent in the worst way: opencode starts fine and
# GET /config happily echoes back a plugin path that does not exist, so the
# obvious "is a plugin configured?" check passes while no hook is loaded. Warn
# loudly instead. Deliberately does NOT auto-build: sourcing a helper must not
# silently spend minutes compiling.
if [ ! -f "$_omo_plugin_entry" ]; then
  printf '[qa-sandbox] WARNING: %s does not exist.\n' "$_omo_plugin_entry" >&2
  printf '[qa-sandbox] WARNING: opencode will start and report this plugin in GET /config,\n' >&2
  printf '[qa-sandbox] WARNING: but NO omo hook will run. Build it first: bun run build\n' >&2
else
  # `find packages -name '*.ts'` includes installed package sources under
  # node_modules. Those are routinely newer than dist and would make every
  # sandbox claim its build is stale. Only tracked source files are relevant.
  _omo_stale_source=""
  while IFS= read -r _omo_source; do
    if [ "$_omo_repo_root/$_omo_source" -nt "$_omo_plugin_entry" ]; then
      _omo_stale_source="$_omo_source"
      break
    fi
  done <<EOF
$(git -C "$_omo_repo_root" ls-files -- 'packages/omo-opencode/src/**/*.ts' 'packages/omo-opencode/src/*.ts')
EOF
  if [ -n "$_omo_stale_source" ]; then
    printf '[qa-sandbox] WARNING: %s is OLDER than tracked source %s.\n' "$_omo_plugin_entry" "$_omo_stale_source" >&2
    printf '[qa-sandbox] WARNING: QA would exercise the PREVIOUS build. Rebuild: bun run build\n' >&2
  fi
  unset _omo_source _omo_stale_source
fi
if [ -f "$_omo_repo_root/.env" ]; then
  case "$-" in *a*) _omo_had_allexport=1 ;; *) _omo_had_allexport=0 ;; esac
  set -a
  # shellcheck disable=SC1091
  . "$_omo_repo_root/.env"
  [ "$_omo_had_allexport" = "1" ] || set +a
  unset _omo_had_allexport
fi
unset _omo_self _omo_repo_root _omo_plugin_entry

printf '[qa-sandbox] isolated env ready under %s\n' "$OMO_QA_ROOT"
printf '[qa-sandbox]   HOME=%s\n' "$HOME"
printf '[qa-sandbox]   XDG_CONFIG_HOME=%s\n' "$XDG_CONFIG_HOME"
printf '[qa-sandbox]   CODEX_HOME=%s\n' "$CODEX_HOME"
printf '[qa-sandbox]   OMO_QA_PROJ=%s\n' "$OMO_QA_PROJ"
printf '[qa-sandbox]   omo plugin registered: %s/opencode/opencode.json\n' "$XDG_CONFIG_HOME"
printf '[qa-sandbox] RUN QA FROM $OMO_QA_PROJ (cd "$OMO_QA_PROJ"). Staying in a directory\n'
printf '[qa-sandbox] under your real home lets the config walk claim ~/.omo as a PROJECT\n'
printf '[qa-sandbox] layer, which outranks the sandbox and is migration-writable.\n'
printf '[qa-sandbox] Then host ~/.config/opencode, ~/.codex, and ~/.omo are untouched.\n'
printf '[qa-sandbox] Git identity and ~/.ssh do not follow into the sandbox.\n'
printf '[qa-sandbox] Clean up: rm -rf "%s"\n' "$OMO_QA_ROOT"
