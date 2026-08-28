# oh-my-opencode — OpenCode Plugin

> **HOLD THE FUCK UP. THIS ENTIRE GODDAMN CODEBASE IS BEING RIPPED APART AND REBUILT RIGHT NOW. A MASSIVE MULTI-HARNESS AGENT OS REFACTOR IS IN PROGRESS — WE ARE RESTRUCTURING EVERYTHING TO SUPPORT MULTIPLE AGENT HARNESSES (OPENCODE, CODEX, PI, AND OTHERS). DO NOT TRUST THE STRUCTURE BELOW AS STABLE. READ THE [ROADMAP](./ROADMAP.md) BEFORE YOU TOUCH ANYTHING OR SO HELP ME GOD.**

**Generated:** 2026-08-07 | **Source snapshot:** 51ab1e5b6 | **Branch:** dev | **Release:** v4.19.4

## STOP. QA IS MANDATORY. NON-NEGOTIABLE. EVERY SINGLE TIME YOU TOUCH AN OPENCODE- OR CODEX-CONNECTED COMPONENT.

> **IF YOUR CHANGE TOUCHES ANYTHING WIRED INTO OPENCODE OR INTO THE CODEX LIGHT EDITION, YOU MUST QA IT. ALWAYS. EVERY SINGLE TIME. NO EXCEPTIONS. THERE IS NO "TOO SMALL TO SKIP". THERE IS NO "IT OBVIOUSLY WORKS".**

**"It typechecks" is NOT QA. "`bun test` is green" is NOT QA.** YOU MUST DRIVE THE REAL HARNESS, and then **YOU MUST WRITE THE EVIDENCE TO DISK.** If there is no evidence file, **the QA DID NOT HAPPEN**, and **YOU ARE NOT ALLOWED TO COMMIT OR PUSH.**

This is repeated on purpose, because it is the single most ignored rule in this repo. **CHANGE A HOOK, A TOOL, AN AGENT, A FEATURE, A CONFIG SCHEMA, AN MCP, A CLI COMMAND, AN INSTALLER, A PROMPT, OR ANYTHING ELSE THAT REACHES OPENCODE OR CODEX, THEN: RUN QA, THEN RECORD EVIDENCE.** Always. Every time. No exceptions.

**RUN THE SKILL THAT MATCHES WHAT YOU TOUCHED.** Each skill carries the full per-case procedure, the isolation setup, and the hook-proof scripts. READ IT, do not improvise a substitute.

- **OPENCODE side** (`packages/omo-opencode/`) → the **`opencode-qa`** skill (`.agents/skills/opencode-qa/`). It maps EXPECTED IMPACT and FULL CHANGE SCOPE before and after, and covers CLI, server + SSE hook proof, TUI smoke, and DB inspection. **ISOLATE EVERYTHING** in an XDG sandbox; **NEVER pollute the real `~/.local/share/opencode/opencode.db`.** If you changed a lifecycle hook, PROVE the matching event hit the wire.
- **CODEX side** (`packages/omo-codex/`) → the **`codex-qa`** skill (`.agents/skills/codex-qa/`). It drives the real `codex app-server` against an isolated `CODEX_HOME` plus a LOCAL mock model and asserts `hook/started` / `hook/completed`. NEVER QA against your real `~/.codex`; NEVER the published package. Gate: `bun run test:codex` (hermetic UNIT gate, does NOT prove a live session).
- **A change touching both runs both.**

### EVIDENCE: record it under `.omo/evidence/` or it DID NOT HAPPEN

**WRITE EVERY QA ARTIFACT TO `.omo/evidence/<YYYYMMDD>-<short-slug>/`** (one subfolder per change, keep it ORGANIZED). For EVERY change you MUST record reviewer-readable plain files:
- **WHAT WAS TESTED:** the command or manual action, the surface driven, and the behavior it was meant to prove.
- **WHAT WAS OBSERVED:** the before/after or new behavior, isolation proof such as unchanged session counts, and the artifact path for the exact captured output.
- **WHY IT IS ENOUGH:** how the evidence covers the intended behavior and remaining regression risk.
- **WHAT WAS OMITTED:** redact or summarize raw secret-bearing logs, env dumps, tokens, auth headers, and private credentials instead of copying them.

**NO EVIDENCE FILE == NO QA == NO COMMIT == NO PUSH.** ALWAYS. EVERY TIME. NO EXCEPTIONS.

## MANDATORY CHANGE-EXECUTION PROTOCOL. EVERY USER-ORDERED PATCH FOLLOWS THIS. NO EXCEPTIONS.

> **THE MOMENT A TASK REQUIRES PRODUCING A PATCH THAT MODIFIES THIS REPOSITORY, AND THE USER HAS EXPLICITLY INSTRUCTED THAT MODIFICATION, THIS PROTOCOL IS LAW. IT IS NOT A SUGGESTION. IT IS NOT OPTIONAL. THERE IS NO "TOO SMALL TO BOTHER", NO "JUST THIS ONCE", NO "I ALREADY KNOW THE CODEBASE". YOU RUN EVERY STEP, IN ORDER, EVERY SINGLE TIME.**

1. **EXPLORE.** MAP the code you are about to touch BEFORE editing a single line: read the real files, trace the call paths, measure the blast radius. NEVER patch from memory.
2. **MAKE A PLAN.** Write the full plan down BEFORE the first edit: every file, every change, the verification for each. NO PLAN ON DISK MEANS YOU DO NOT START.
3. **ADD TODOS IN ULTRA-DETAIL.** Mirror EVERY atomic step of the plan into the todo list: one todo per edit-plus-verification unit. Vague todos like "implement feature" are FORBIDDEN.
4. **MAKE A NEW WORKTREE.** ALL implementation happens in a fresh, task-owned git worktree. NEVER edit the main checkout in place, NEVER hand-commit to `dev`.
5. **MAKE A PR AND WORK UNTIL IT GETS MERGED.** Open a reviewer-readable PR and STAY ON IT until it is MERGED: fix CI, answer review, re-run QA, resolve conflicts via `smart-rebase`. AN UNMERGED PR IS UNFINISHED WORK.
6. **SET A GOAL AND RUN THE ULW LOOP.** Register the goal with binding success criteria and drive the work through the `ulw-loop`: evidence-bound, failing-first, real-surface QA. "IT SHOULD WORK" IS NOT EVIDENCE.
7. **MANAGE THE TODO LIST OBSESSIVELY.** Mark a step in progress the instant it begins, done the instant it finishes, append new steps the moment they surface. THE TODO LIST NEVER LAGS REALITY. EVER.

## DEFAULT WORKFLOW — how to take on any task

Unless the user EXPLICITLY says otherwise, or the task is an urgent must-fix-now hotfix, deliver every change through the **`work-with-pr`** skill: it works in an isolated git worktree, implements with evidence-bound manual QA, opens a reviewer-readable English PR (what changed, why, observed behavior, QA/evidence, residual risk), runs the verification loop, and merges. Do NOT hand-commit normal work straight to `dev`.

- **QA is the evidence gate, scoped to what you touched.** A change under `packages/omo-opencode/` MUST run the **`opencode-qa`** skill; a change under `packages/omo-codex/` (lazycodex) MUST run the **`codex-qa`** skill (see the QA section above for each). Run the matching skill, and treat its captured output (written under `.omo/evidence/`) as the QA evidence `work-with-pr` requires. A change touching both runs both.
- **Conflicts → `smart-rebase`.** If the worktree branch conflicts with its base, resolve it with the **`smart-rebase`** skill, then re-run the scoped QA. Never hand-resolve by force-pushing shared history.
- **Merge → merge commit, ALWAYS.** Land the PR with a merge commit per **PR MERGE POLICY** below. NEVER squash-merge or rebase-merge, even if a generic workflow, skill, or GitHub default suggests it.

## OVERVIEW

OpenCode plugin (npm: `oh-my-opencode`, dual-published as `oh-my-openagent` during the rename transition) extending OpenCode with 12 agents, 52-64 lifecycle hooks (base / +goal / +lessons / +monitor / +team-mode) across 64 dirs, 13-40 registry tools (gated by config flags including team-mode, lessons, and goal; 8 `lsp_*` aliases served via the built-in lsp MCP), 3-tier MCP system (built-in + .mcp.json + skill-embedded), Hashline LINE#ID edit tool, IntentGate keyword detector, Team Mode (parallel multi-agent coordination, OFF by default), Boulder feature (boulder-state work tracking + cli/boulder subcommand), configurable agent ordering, and Claude Code compatibility.

**The package layering refactor moved the entire plugin out of root `src/` into [`packages/omo-opencode/src/`](packages/omo-opencode/src/AGENTS.md)** (a 100% git rename — there is NO root `src/` anymore). That adapter tree is now the OpenCode-facing shim over 19 Core packages + 4 MCP packages + the Codex adapter. Build entry: `packages/omo-opencode/src/index.ts`, a thin wrapper that delegates to `packages/omo-opencode/src/testing/create-plugin-module.ts` `createPluginModule()` → staged plugin init (see PLUGIN INTERNALS). Ships in two editions of one product: **Ultimate** (omo for OpenCode, this plugin = `packages/omo-opencode/`) and **Light** (omo for Codex CLI = [`packages/omo-codex/`](packages/omo-codex/AGENTS.md), with `lazycodex` as the repository/bin identity and `lazycodex-ai` as the live npm alias; see CODEX LIGHT EDITION below).

## STRUCTURE

```
oh-my-opencode/                      # workspace root (no root src/ — it moved into packages/omo-opencode)
├── packages/                        # 43 sibling packages across Core/MCP/Skills/Adapters/Platform/Web
├── bin/                             # Platform-detection JS shim; 5 public aliases
├── script/                          # Bun/TS build/publish automation (singular)
├── scripts/                         # Node ESM third-party-notice helpers
├── docs/                            # User-facing docs (guide/, reference/, examples/, legal/, manifesto.md, troubleshooting/)
├── assets/                          # Generated config/help schemas
├── test-support/ tests/             # Shared helpers + repo-level integration tests
├── signatures/                      # CLA signature registry (cla.json)
├── postinstall.mjs                  # Verifies platform binary + OpenCode version
├── test-setup.ts                    # Bun test preload (resets state between tests)
├── .opencode/  .agents/             # Project-scope skills + commands (.agents/ is the recent migration target)
├── .omo/                            # AI agent workspace (rules/, plans/, tasks/, teams/, ulw-loop/, notepads/)
└── .local-ignore/                   # Dev-only test fixtures + PR worktrees (NOT part of the real AGENTS.md hierarchy)
```

Every directory above owns its own `AGENTS.md`, read on demand when you touch a file inside it. Do NOT duplicate their content here.

- Package roles, the 12 platform launchers, MCP and Core package tables → [`packages/AGENTS.md`](packages/AGENTS.md)
- The plugin adapter tree (`index.ts`, `plugin-interface.ts`, `agents/`, `hooks/`, `tools/`, `features/`, `shared/`, `config/`, `cli/`, `mcp/`, `plugin/`, `openclaw/`), plus its full subsystem inventory → [`packages/omo-opencode/src/AGENTS.md`](packages/omo-opencode/src/AGENTS.md)
- Build/publish automation → [`script/AGENTS.md`](script/AGENTS.md). CI workflows → [`.github/workflows/AGENTS.md`](.github/workflows/AGENTS.md). Docs layout → [`docs/AGENTS.md`](docs/AGENTS.md). Test layout → [`tests/AGENTS.md`](tests/AGENTS.md). Launcher shim → [`bin/AGENTS.md`](bin/AGENTS.md).

## PLUGIN INTERNALS (init flow, hook handlers, tool catalog)

All three live in [`packages/omo-opencode/src/AGENTS.md`](packages/omo-opencode/src/AGENTS.md), read on demand when you open a file in that tree:

- **INITIALIZATION FLOW** - the ~20-stage staged boot of `serverPlugin()` in `packages/omo-opencode/src/testing/create-plugin-module.ts`, from `installAgentSortShim()` through `createPluginDispose()`.
- **14 OPENCODE HOOK HANDLERS** - 12 wired in [`packages/omo-opencode/src/plugin-interface.ts`](packages/omo-opencode/src/plugin-interface.ts) plus `experimental.session.compacting` and `experimental.compaction.autocontinue` wired directly in `testing/create-plugin-module.ts`.
- **TOOL CATALOG** - 13 always-on registry tools, up to 40 with config gates. The 8 `lsp_*` aliases are NOT registry registrations; they are served by the built-in `lsp` MCP via `packages/lsp-tools-mcp`. Structural search and rewrite comes from the `ast-grep` skill using `sg`.

## TEAM MODE

OFF by default. Parallel multi-agent coordination, modeled after Claude Code Agent Teams. Enable via `team_mode.enabled` in `.omo/omo.jsonc`; restart OpenCode after the change.

Members are declared `kind: "subagent_type"` (direct agent) or `kind: "category"` (routed through `sisyphus-junior`). Only sisyphus, atlas, and sisyphus-junior are eligible; oracle, librarian, explore, multimodal-looker, metis, momus, and prometheus are rejected at TeamSpec parse (use `task`/delegate-task instead). Teams live under `~/.omo/teams/{name}/` (user) or `<project>/.omo/teams/{name}/` (project wins on collision).

Full 11-field config schema, the 12 `team_*` tools, eligibility registry, storage layout, lifecycle, and invariants → [`packages/omo-opencode/src/features/team-mode/AGENTS.md`](packages/omo-opencode/src/features/team-mode/AGENTS.md). User docs: [`docs/guide/team-mode.md`](docs/guide/team-mode.md).

## CODEX LIGHT EDITION (omo-codex / lazycodex)

oh-my-openagent ships in two editions of one product. **Ultimate** = this OpenCode plugin (`packages/omo-opencode/`). **Light** = omo for the OpenAI Codex CLI, vendored under [`packages/omo-codex/`](packages/omo-codex/AGENTS.md). "omo in Codex" / "omo for Codex" = **lazycodex**.

Identity in one line: Codex sees marketplace `sisyphuslabs`, plugin `omo`, enabled as `omo@sisyphuslabs`. `lazycodex-ai` is the live npm alias; `lazycodex` is the repository/bin identity, never the marketplace name; the public repo [`code-yeongyu/lazycodex`](https://github.com/code-yeongyu/lazycodex) is the thin marketplace/distribution layer.

Install: `bunx oh-my-openagent install --platform=codex` (or `bunx lazycodex-ai install`, or `--platform=both`). CI gate: `bun run test:codex`.

[`packages/omo-codex/AGENTS.md`](packages/omo-codex/AGENTS.md) is the SOURCE OF TRUTH for the 11 components, bin aliases and routing, installer mechanics, unified config, config migration, telemetry, the publish job, and the automatic stable-release marketplace sync. Do NOT restate any of it here.

## MULTI-LEVEL CONFIG

One unified file configures every omo harness (OpenCode plugin, Senpi, Codex codegraph loader): `~/.omo/omo.json[c]` as the user layer, with project layers at `<pwd up to $HOME>/.omo/omo.json[c]` (nearest wins, `$HOME` itself skipped) merged on top, then resolved per harness as shared base → `[harness]` block → `profiles.<P>` → `profiles.<P>.[harness]`, with Zod schema defaults applied last. Legacy `oh-my-openagent.json[c]` / `oh-my-opencode.json[c]` and `~/.omo/config.jsonc` are read by nothing but the migration engine.

Two security rules that bite: `mcp_env_allowlist` and `browser_automation_engine.playwright_mcp_args` are **user-layer only** (project layers cannot extend them), and object merges are recursive but prototype-pollution safe while scalars and arrays replace.

Layer precedence internals, filename resolution, the `models` catalog, profile activation order, writer guarantees, and the migration ids/triggers → [`packages/omo-config-core/AGENTS.md`](packages/omo-config-core/AGENTS.md) and [`docs/reference/omo-json.md`](docs/reference/omo-json.md).

Schema autocomplete: `"$schema": "https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/assets/omo.schema.json"`

## THREE-TIER MCP SYSTEM

| Tier | Source | Loader | Mechanism |
|------|--------|--------|-----------|
| 1. Built-in | `packages/omo-opencode/src/mcp/` | `createBuiltinMcps()` | 3 remote HTTP + 2 local stdio MCPs (`lsp`, `codegraph`) |
| 2. Claude Code | `.mcp.json` (project + user) | `claude-code-mcp-loader` | `${VAR}` env expansion (allowlist via `mcp_env_allowlist`) |
| 3. Skill-embedded | SKILL.md YAML frontmatter | `SkillMcpManager` (per-session) | stdio + HTTP, OAuth 2.0 + PKCE + DCR step-up |

## WHERE TO LOOK

> All plugin paths below are relative to [`packages/omo-opencode/`](packages/omo-opencode/src/AGENTS.md) (the OpenCode adapter). Core/MCP logic lives in sibling `packages/*`.

| Task | Location | Notes |
|------|----------|-------|
| Add new agent | `packages/omo-opencode/src/agents/` + `agents/builtin-agents/` | `createXXXAgent` factory + `mode: "primary" \| "subagent" \| "all"` |
| Add new hook | `packages/omo-opencode/src/hooks/{name}/` + register in `src/plugin/hooks/create-*-hooks.ts` | Pick the right tier (Session/ToolGuard/Transform/Continuation/Skill) |
| Add new tool | `packages/omo-opencode/src/tools/{name}/` + register in `src/plugin/tool-registry.ts` | Factory `createXXXTool` (most) or direct `ToolDefinition` (interactive_bash) |
| Add new feature module | `packages/omo-opencode/src/features/{name}/` | Standalone module wired into `plugin/` layer |
| Add new MCP (tier 1) | `packages/omo-opencode/src/mcp/` + register in `createBuiltinMcps()` | Remote HTTP or local stdio |
| Add new built-in skill | `packages/omo-opencode/src/features/builtin-skills/skills/{name}.ts` + register in `skills.ts` | Implement `BuiltinSkill` interface |
| Add new command | `packages/omo-opencode/src/features/builtin-commands/` | Templates in `templates/` |
| Modify ultrawork prompts | `packages/prompts-core/prompts/ultrawork/*.md` | `packages/omo-opencode/src/hooks/keyword-detector/ultrawork/*.ts` are loader shims; keep `index.ts` and `source-detector.ts` routing stable |
| Add new CLI subcommand | `packages/omo-opencode/src/cli/cli-program.ts` | Commander.js subcommand |
| Add new doctor check | `packages/omo-opencode/src/cli/doctor/checks/` | Register in `checks/index.ts` |
| Modify config schema | `packages/omo-opencode/src/config/schema/` + add to `OhMyOpenCodeConfigSchema` | Zod v4; auto-included in `assets/oh-my-opencode.schema.json` after `bun run build:schema` |
| Add new category | `packages/omo-opencode/src/tools/delegate-task/constants.ts` | `DEFAULT_CATEGORIES` + `CATEGORY_MODEL_REQUIREMENTS` |
| Add new team-mode tool | `packages/omo-opencode/src/features/team-mode/tools/` + register in `src/plugin/tool-registry.ts` `teamModeToolsRecord` | Gated on `team_mode.enabled` |
| Reactive provider error recovery | `packages/omo-opencode/src/hooks/runtime-fallback/` | Distinct from `model-fallback` (proactive, chat.params) |
| External notifications | `packages/omo-opencode/src/openclaw/` | Bidirectional: outbound (event → HTTP/shell), inbound (Discord/Telegram daemon → tmux send-keys) |
| Skill-embedded MCP | `packages/omo-opencode/src/features/skill-mcp-manager/` | Tier-3 MCPs (per-session, stdio + HTTP) |
| Shared per-user LSP daemon (Codex) | `packages/lsp-daemon/` | Unix-socket / named-pipe daemon + stdio MCP proxy consuming `packages/lsp-core/` + `packages/mcp-stdio-core/` |

## ARCHITECTURE INVARIANTS

- **Canonical agent order:** Sisyphus → Hephaestus → Prometheus → Atlas. Enforced by `installAgentSortShim()` (patches `Array.prototype.toSorted`/`.sort` narrowly when the array contains ≥2 canonical core agents). See [`packages/omo-opencode/src/plugin-handlers/AGENTS.md`](packages/omo-opencode/src/plugin-handlers/AGENTS.md) for the full history of why this exists.
- **Hashline edit + read pairing:** Every `Read` tool output is tagged with `LINE#ID` content hashes; `hashline_edit` validates the hash before applying. Stale hash → reject.
- **5-tier hook composition:** Session (26) + ToolGuard (18) + Transform (7) + Continuation (7) + Skill (2) = 60 composed hook slots. 8 of those slots are config-gated null by default: Transform-tier `team-mode-status-injector`/`team-mailbox-injector` via `team_mode.enabled` and `monitor-status-injector` via `monitor.enabled`, plus Session-tier `goal` (`goal.enabled`), `lesson-nudge` (`lessons.enabled` + `lessons.nudge`), `model-fallback` (`model_fallback`, default off), `preemptive-compaction` (`experimental.preemptive_compaction`), and `interactive-bash-session` when tmux integration is off → **52 active on default config**. Note `team-tool-gating` (ToolGuard) is always composed and gates itself internally on `config.enabled`, so it counts as active. Team mode also adds +4 direct event handlers in `packages/omo-opencode/src/plugin/event.ts` (`team-session-events/*`) → **64 max**. Composed by `createCoreHooks()` + `createContinuationHooks()` + `createSkillHooks()`; the Transform tier also pulls `contextInjectorMessagesTransform` from `features/context-injector` (not a `hooks/` dir).
- **Per-session MCP isolation:** Tier-3 MCP clients keyed by `${sessionID}:${skillName}:${serverName}` so the same skill in two sessions does not share state.
- **Two fallback systems:** `model-fallback` (proactive, chat.params) vs `runtime-fallback` (reactive, session.error). They operate independently — no direct integration.
- **OpenClaw bidirectional:** Outbound dispatchers fire on session events; inbound daemon polls Discord/Telegram and `send-keys` replies into the tracked tmux pane.
- **Internal message injection is dangerous:** OpenCode lets a plugin corrupt the main session through `session.prompt` / `session.promptAsync`. Treat every such call as a write to shared session state. Production code may call them ONLY inside `packages/omo-opencode/src/shared/prompt-async-gate.ts`; every other route MUST use `dispatchInternalPrompt({ mode: "async" | "sync", ... })`. Gate semantics, forbidden patterns, and the required regression tests are enforced as a path-scoped rule: [`.omo/rules/internal-prompt-injection.md`](.omo/rules/internal-prompt-injection.md) (auto-injected when you touch a dispatch route). Design rationale: [`docs/reference/prompt-async-gate-rfc.md`](docs/reference/prompt-async-gate-rfc.md).

## CONVENTIONS

- **Runtime:** Bun only (1.3.12 in CI). Never npm/yarn/pnpm. (Exceptions: `packages/lsp-tools-mcp` + `packages/lsp-daemon` are Node-targeted, vendored, and built with `npm` + vitest/biome.)
- **TypeScript:** strict mode, ESNext, bundler moduleResolution, `bun-types` (never `@types/node`).
- **Tests:** Bun test (`bun:test`), co-located `*.test.ts`, given/when/then style — nested `describe` with `#given`/`#when`/`#then` prefixes, or inline `// given` / `// when` / `// then` comments. Never Arrange-Act-Assert comments.
- **CI tests:** plain `bun test` runs the root Bun suite in one process; no sharding or split isolation runner.
- **Test setup:** `test-setup.ts` preloaded via `bunfig.toml` resets session/cache state between tests.
- **Factory pattern:** `createXXX()` for all tools, hooks, agents.
- **File naming:** kebab-case for files and directories.
- **Module structure:** `index.ts` barrel exports, **no catch-all files** (`utils.ts`, `helpers.ts`, `service.ts` banned), 200 LOC soft limit per file.
- **Imports:** relative within a module, barrel imports across modules (`import { log } from "./shared"`). **No path aliases inside package `src/`** — never `@/`. `packages/web/` is the only exception: it uses `@/*` (Next.js convention) and has its own tsconfig.
- **Config format:** JSONC with comments + trailing commas, Zod v4 validation, snake_case keys.
- **Dual package:** `oh-my-opencode` + `oh-my-openagent` published simultaneously during the rename transition.
- **Comments:** AI slop comment patterns blocked by `comment-checker` hook (binary: `@code-yeongyu/comment-checker`). Use `// @allow` to bypass single line, `// comment-checker-disable-file` at file top to bypass file. Sparingly.

## ANTI-PATTERNS (BLOCKING)

- Never `as any`, `@ts-ignore`, `@ts-expect-error`.
- Never suppress lint/type errors.
- Never add emojis to code/comments unless user explicitly asks.
- Never commit unless explicitly requested.
- Never run `bun publish` directly — use the GitHub Actions workflow.
- Never modify `package.json` `version` locally — handled by publish workflow.
- Never write to existing files without reading them first (`write-existing-file-guard`).
- Never use `background_cancel(all=true)` — cancel by `taskId` individually.
- Never delete a failing test to make a build green. Fix the code.
- Never bypass a red required check with `--admin`, a skipped or weakened test, retry masking, platform or shell exclusion, or an environment-specific workaround.
- Never em dashes / en dashes / AI filler ("simply", "obviously", "clearly", "moreover", "furthermore") in generated content.
- Never create catch-all files (`utils.ts`, `helpers.ts`, `service.ts`).
- Never empty catch blocks `catch(e) {}`.
- Never test with Arrange-Act-Assert comments — use given/when/then.
- Never dump business logic into `index.ts` — barrel exports only.
- Prometheus may ONLY edit `.md` files (enforced by `prometheus-md-only` hook); FORBIDDEN paths: `packages/*/src/`, `package.json`, config files.

## COMMANDS

```bash
bun test                          # Root Bun test suite in one process
bun run test:codex                # Codex Light gate: git-bash-mcp + lsp-tools-mcp + lsp-daemon + codegraph + omo-codex plugin + third-party notices (ast-grep-mcp is senpi-side, not in this gate)
bun run build                     # Build plugin (ESM bundle ← packages/omo-opencode/src/index.ts + .d.ts + cli bundle + schema)
bun run build:all                 # Build + 12 generated platform launchers
bun run build:binaries            # 12 generated platform launchers only (script/build-binaries.ts)
bun run build:lsp-tools-mcp       # npm ci + build the vendored LSP MCP package
bun run build:lsp-daemon          # npm ci + build the vendored per-user LSP daemon package
bun run build:schema              # Regenerate assets/oh-my-opencode.schema.json
bun run build:model-capabilities  # Refresh shared/model-capabilities cache from models.dev
bun run typecheck                 # tsgo --noEmit + typecheck:script + typecheck:packages (NOT tsc; @typescript/native-preview)
bun run typecheck:packages        # tsgo per workspace package
bun run clean                     # rm -rf dist
bunx oh-my-opencode install       # Interactive setup wizard
bunx oh-my-opencode doctor        # Health diagnostics (4 categories: System / Config / Tools / Models)
bunx oh-my-opencode run <message> # Non-interactive session (auto-completes when todos done + no bg tasks)
bunx oh-my-opencode mcp oauth login <server-name> # Tier-3 MCP OAuth (PKCE + DCR); top-level command is `mcp` with nested `oauth login|logout|status`
```

## DEVELOPMENT ENVIRONMENT

Cross-harness, one-command dev setup. The **single source of truth** is [`script/agent/setup.sh`](script/agent/setup.sh): it verifies the toolchain (bun/node/git, warns if tmux is missing), runs `bun install`, and runs `bun run build` only when `dist/index.js` is missing or `OMO_AGENT_FORCE_BUILD=1` (cheap to re-run). [`script/agent/cleanup.sh`](script/agent/cleanup.sh) removes regenerable transients by default and takes `--deep` to also drop `dist/`, vendored `packages/*/dist/`, and `node_modules/`. [`script/agent/cleanup-hook.sh`](script/agent/cleanup-hook.sh) is the non-blocking Claude Code SessionEnd launcher for that cleanup worker. Every harness below delegates to those scripts, so there is exactly one place to maintain. Claude Code reads [`CLAUDE.md`](CLAUDE.md) (a symlink to this AGENTS.md) and OpenCode reads this file, so every harness shares one infra.

| Harness | Committed wiring | Runs |
|---------|------------------|------|
| GitHub Codespaces / VS Code Dev Containers | [`.devcontainer/devcontainer.json`](.devcontainer/devcontainer.json) + [`.devcontainer/Dockerfile`](.devcontainer/Dockerfile) (Node 24 + Bun 1.3.12 + tmux) | `postCreateCommand` runs `setup.sh` on container create |
| Plain Docker | [`script/agent/docker-dev.sh`](script/agent/docker-dev.sh) | builds the same Dockerfile, opens a shell |
| Cursor cloud agents | [`.cursor/environment.json`](.cursor/environment.json) | `install` runs `setup.sh` on environment creation |
| Claude Code | [`.claude/settings.json`](.claude/settings.json) | `SessionStart` runs `setup.sh`, `SessionEnd` launches `cleanup-hook.sh` |
| Codex App (local environments) | [`.codex/setup.sh`](.codex/setup.sh) | committable setup script Codex runs at project root on worktree creation |
| Codex Cloud / Codex CLI | no committable hook | Cloud: paste the `setup.sh` commands into the web-UI Setup script field. CLI: AGENTS.md only. |
| OpenCode (this plugin's own harness) | root [`AGENTS.md`](AGENTS.md) + [`CLAUDE.md`](CLAUDE.md) symlink | no worktree hook; run `script/agent/setup.sh` (Claude Code auto-runs it via `.claude/settings.json`) |

**Credentials and isolation.** [`.env.example`](.env.example) is the committed injection point: copy it to `.env` (gitignored) ONCE and fill in keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, optionally `OPENCODE_SERVER_PASSWORD`). `setup.sh` and `qa-sandbox.sh` auto-source `.env`, so credentials are set once per machine and never prompted again. For QA, `source` [`script/agent/qa-sandbox.sh`](script/agent/qa-sandbox.sh): it exports an isolated, throwaway environment (its own `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`XDG_STATE_HOME`, a redirected `HOME`, and a fresh `CODEX_HOME` under a `mktemp` dir, plus `OPENCODE_DISABLE_AUTOUPDATE`/`OPENCODE_DISABLE_MODELS_FETCH`) so QA NEVER reads or writes the host's real `~/.config/opencode`, `~/.codex`, or `~/.omo`. **`HOME` redirection is load-bearing, not tidiness:** the plugin's own config chain is `$HOME/.omo/omo.json[c]`, which is NOT an XDG path, so isolating only `XDG_*` leaves it resolving to the operator's real config — a QA run that pins agent/category models to a mock then overwrites it (this destroyed a real `~/.omo/omo.jsonc`; see [`docs/troubleshooting/harness-findings.md`](docs/troubleshooting/harness-findings.md), 2026-08-28). The helper relinks `$HOME/.opencode/bin` into the sandbox because some installed opencode wrappers resolve the real binary through that path.

**You MUST `cd "$OMO_QA_PROJ"` — moving `HOME` is necessary but not sufficient.** Project config layers are collected by walking `cwd` upward until `$HOME` ([`packages/omo-config-core/src/loader/paths.ts:75-101`](packages/omo-config-core/src/loader/paths.ts)) and they OUTRANK the user layer. From a cwd under your real home — which is this repo's own layout — that walk sails past the sandbox boundary and claims the real `~/.omo` as a *project* layer that beats the sandbox, and that the migration engine can write to. The sandbox exports `OMO_QA_PROJ` for exactly this; running there terminates the walk inside the sandbox. Isolation is complete only when **both** `HOME` and `cwd` sit inside it. Note also that git identity and `~/.ssh` do not follow into the sandbox, so commits made from a sandboxed shell get the wrong author. Mirrors the `opencode-qa` and `codex-qa` skill conventions. For containerized environments, [`.devcontainer/README.md`](.devcontainer/README.md) documents how to inject provider credentials and your `~/.codex`, `~/.claude`, and `~/.config/opencode` config into the container.

**MAINTENANCE - KEEP THIS IN SYNC.** `script/agent/setup.sh`, `script/agent/cleanup.sh`, and harness launchers such as `script/agent/cleanup-hook.sh` are the contract. Whenever a setup dependency or configuration is added, breaks, or changes (a new build step, a pinned tool version in the Dockerfile, a new env var or credential, a new harness wiring file), you MUST, in the SAME change, update: this section; the matching "Development Environment" / "Credentials & Isolation" sections in [`CONTRIBUTING.md`](CONTRIBUTING.md); [`.devcontainer/README.md`](.devcontainer/README.md) if container config injection changed; and the matching skill (`opencode-qa` for the OpenCode side, `codex-qa` for the Codex side) whose isolation conventions `qa-sandbox.sh` mirrors. Keep `script/agent-env.test.ts`, `script/agent-harness-wiring.test.ts`, and `script/agents-md-dev-env.test.ts` green. `CLAUDE.md` is a symlink to this file, so the Claude side stays in sync automatically. The scripts, the docs, and the skills must never drift out of sync.

## CI/CD

11 workflows. Full Workflow / Trigger / Purpose table → [`.github/workflows/AGENTS.md`](.github/workflows/AGENTS.md).

The two rules that constrain every change: **PRs targeting `master` are hard-blocked and MUST target `dev`**, and `publish.yml` is manual-dispatch only (never run `bun publish` locally).

## PR MERGE POLICY

- **PRs into `dev` MUST use merge commits.**
- Use `gh pr merge <number> --merge --delete-branch` after CI, review-work, and Cubic pass.
- **NEVER squash merge or rebase merge** PRs in this repository, even if a generic workflow, skill, or GitHub default suggests it.
- If another instruction says `--squash` or `--rebase`, this repo-level rule overrides it.
- **NEVER use `gh pr merge --admin` or any required-check override.** Do not request or act on authorization to bypass a gate.
- A required check that is already red on `dev` is a base-branch defect and remains a merge blocker. Inspect the latest `dev` run, reproduce the failure on the matching platform and toolchain, root-fix it in the current PR or a separate atomic PR, rebase onto the repaired `dev`, rerun every required check, and record the evidence.
- Reducing the failure count is not a green result. Never make a gate disappear through `test.skip`, weakened assertions, retry loops, `continue-on-error`, platform or shell exclusion, or an environment-specific workaround.

## NOTES

- **Logger:** writes `oh-my-opencode.log` to the OS temp dir (`/tmp` on Linux, `/var/folders/.../T/` on macOS, `%TEMP%` on Windows — i.e. Node's `os.tmpdir()`). Rotated at 50 MB; previous segments live at `.1` and `.2` (oldest dropped).
- **Background tasks:** 5 concurrent per `${providerID}/${modelID}` key by default (configurable via `background_task.modelConcurrency` / `providerConcurrency`); FIFO queue when slots full.
- **Plugin load timeout:** 10s for Claude Code plugin discovery.
- **Model fallback:** per-agent chains in `packages/omo-opencode/src/shared/model-requirements.ts`. **There is no single global priority.**
- **Two fallback systems:** `model-fallback` (proactive, chat.params, hardcoded chains) vs `runtime-fallback` (reactive, session.error, configurable per-category/agent).
- **Config migration:** idempotent via `_migrations` tracking, atomic writes with timestamped backups.
- **Goal feature (replaces ralph-loop):** `packages/omo-opencode/src/hooks/goal/` session-tier hook + `create_goal`/`update_goal`/`get_goal` tools, gated on `goal.enabled` (default off). Legacy `ralph_loop` config migrates to `goal` in `packages/omo-opencode/src/config/validate.ts` (deprecated schema shim); `ralph-loop` hook dir retained but no longer wired.
- **Lessons feature:** `packages/omo-opencode/src/tools/record-lesson/` writes durable `.md` rule files under `~/.omo/rules/lessons/`, gated on `lessons.enabled` (default off). The rules-injector reads them back in future sessions.
- **Build:** `bun build` (ESM, entry `packages/omo-opencode/src/index.ts`) + `tsc --emitDeclarationOnly`, external: `zod`.
- **Barrel `index.ts` files** establish module boundaries within `packages/omo-opencode/src/`.
- **Architecture rules** enforced via the `rules-injector` hook reading `.omo/rules/*.md`. Rules are PATH-SCOPED through their frontmatter `globs`, so a rule loads only when you touch a file it matches. Keep new rules narrowly scoped; never use `alwaysApply: true` for reference material.
- **Platform launchers:** detect AVX2 + libc family at runtime, fallback to baseline if needed.
- **IntentGate (`keyword-detector`):** classifies user intent (`ultrawork`/`ulw`, `search`, `analyze`, `team`) and injects mode-specific prompts.
- **Hashline edit:** every `Read` output tagged with `LINE#ID` content hashes (chars from `ZPMQVRWSNKTXJBYH`); edits reject on hash mismatch.
- **zauc-mocks pattern:** directories named `zauc-mocks-*` hold `mock.module()` setup that must load alphabetically before the tests consuming those mocked modules. The `zauc-` prefix is purely a sort-order hack for `bun:test` discovery; these are NOT hooks/tools.
- **Meta-audit tests parse source and FAIL the suite on invariant violations.** They cover raw prompt calls outside the gate, `mock.module()` without restore, workspace/devDep registration, `packages/*-core` harness neutrality, machine-local absolute paths in committed `.md`, and `@opencode-ai/*` imports from non-adapter packages. Full inventory → [`tests/AGENTS.md`](tests/AGENTS.md) and [`.omo/rules/test-discipline.md`](.omo/rules/test-discipline.md).
- **Docs:** see [`docs/guide/`](docs/guide) for user-facing guides (overview, installation, orchestration, agent-model-matching, team-mode), [`docs/reference/`](docs/reference) for CLI/configuration/features reference. See also [`CHANGELOG.md`](CHANGELOG.md), [`docs/reference/prompt-async-gate-rfc.md`](docs/reference/prompt-async-gate-rfc.md), and [`docs/reference/release-process.md`](docs/reference/release-process.md).
- **Harness defects:** log harness/tool footguns and surprising harness behavior in [`docs/troubleshooting/harness-findings.md`](docs/troubleshooting/harness-findings.md) (append-only). Do not file them as a new field-report, handover, or spec file, and do not file them in the project repo where they were observed. The `harness-findings-review` skill is the read side (manual invocation only).
- **Rules files** (auto-injected by `rules-injector` hook): scans `.omo/rules/`, `.claude/rules/`, `.cursor/rules/`, `.github/instructions/`, plus `.github/copilot-instructions.md` and `.mdc` files.
- **Process cleanup:** Background-agent error handlers are now log-only — no force-exit on transient errors. Opt out entirely via `OMO_DISABLE_PROCESS_CLEANUP=1` env var.
- **First-prompt watchdog:** `packages/omo-opencode/src/hooks/runtime-fallback/first-prompt-watchdog.ts` detects subagent sessions producing no progress within 90s and triggers fallback / abort.
- **ParentWakeNotifier:** Background-agent parent-wake state in `packages/omo-opencode/src/features/background-agent/parent-wake-notifier.ts` with dependency-injected client and enqueue callback.
- **Agent state directory:** ONE canonical location, `~/.omo/agent`, resolved through `canonicalAgentDir()` in [`packages/omo-native/bin/lib/agent-dir.js`](packages/omo-native/bin/lib/agent-dir.js) (and its adapter-side twin `resolveAgentHome()` in `packages/omo-senpi/src/components/agent-home/`). EVERY omo entry point - the spawned engine, `omo doctor`, `omo setup`, the local launcher, the local installer - MUST resolve the directory through that helper instead of composing its own default; an explicit `OMO_CODING_AGENT_DIR` (or the legacy `SENPI_CODING_AGENT_DIR` / `PI_CODING_AGENT_DIR`) still wins. Composing a private default is what made settings look erased on update.
- **Workspace migration:** Runtime state migrated from `.sisyphus/` → `.omo/`. Legacy `.sisyphus/` still exists during transition; `packages/omo-opencode/src/shared/legacy-workspace-migration.ts` copies it forward on first load.
- **CI nuance:** PRs targeting `master` are hard-blocked — they MUST target `dev`. CI auto-commits schema changes on master push and creates a draft "next" release on dev push.
