# src/ - Plugin Source

**Generated:** 2026-08-07 / 51ab1e5b6

## STOP. THIS IS THE OPENCODE PLUGIN. QA IS MANDATORY. EVERY SINGLE TIME YOU CHANGE ANYTHING HERE.

> **EVERYTHING UNDER THIS `src/` IS WIRED DIRECTLY INTO OPENCODE. IF YOU EDIT A HOOK, A TOOL, AN AGENT, A FEATURE, A CONFIG SCHEMA, AN MCP, A CLI COMMAND, A PLUGIN HANDLER, OR ANYTHING ELSE IN HERE, YOU MUST QA IT AGAINST REAL OPENCODE. ALWAYS. EVERY SINGLE TIME. NO EXCEPTIONS.**

**"It typechecks" is NOT QA. "`bun test` is green" is NOT QA.** YOU MUST DRIVE REAL OPENCODE AND RECORD THE EVIDENCE TO DISK. NO EVIDENCE == NO QA == NO COMMIT == NO PUSH.

**ALWAYS RUN THE `opencode-qa` SKILL** (`.agents/skills/opencode-qa/`) to map the EXPECTED IMPACT and the FULL CHANGE SCOPE of your edit:

1. **MAP THE BLAST RADIUS** with the skill router (CLI / server + SSE hook proof / TUI smoke / DB inspection), BEFORE and AFTER your change.
2. **ISOLATE EVERYTHING.** Any QA that SPAWNS opencode MUST run in an isolated XDG sandbox (`XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` pointed at temp dirs). **NEVER pollute the real `~/.local/share/opencode/opencode.db`.** PROVE it: `SELECT count(*) FROM session` unchanged before vs after.
3. **PROVE THE HOOK / EVENT FIRED.** Changed a lifecycle hook? Prove the matching event hit the wire (`scripts/sse-hook-probe.sh --event <name>`). Changed a tool? Drive it via `opencode run --format json` and assert on the structured events.
4. **USE tmux** for TUI smoke (`scripts/tui-smoke.sh`) and interactive driving; assert REAL behavior via `opencode run` or the server API + SSE, not the TUI pane.

**RECORD THE EVIDENCE UNDER `.omo/evidence/<YYYYMMDD>-<short-slug>/`** (one organized subfolder per change): WHY THERE IS NO REGRESSION (before/after + isolation proof + exact commands and output) and PROOF THAT EVERY INTENDED CHANGE LANDED (new behavior observed on real opencode). See the root [`AGENTS.md`](../../../AGENTS.md) "STOP. QA IS MANDATORY" section for the full mandate, which also covers the Codex side.

**ALWAYS. EVERY TIME. NO EXCEPTIONS.**

## OVERVIEW

Entry `index.ts` orchestrates a staged initialization across the directories below. Cross-cutting adapter helpers live in `shared/`; barrel `index.ts` files establish module boundaries. Several former implementation directories now act partly as OpenCode-facing shims over extracted Core packages.

## KEY FILES

| File | Purpose |
|------|---------|
| `index.ts` | Plugin entry; default-exports `pluginModule: PluginModule` with `{ id, server }` |
| `plugin-config.ts` | JSONC parse, multi-level merge (user + walked project), Zod v4 validation, migration |
| `plugin-state.ts` | `createModelCacheState()`: model resolution cache shared across handlers |
| `plugin-interface.ts` | 12 of the 14 OpenCode hook handlers wired into `Hooks`; see ## 14 OPENCODE HOOK HANDLERS below for the full table |
| `create-managers.ts` | TmuxSessionManager, BackgroundManager, SkillMcpManager, ConfigHandler |
| `create-tools.ts` | SkillContext + AvailableCategories + ToolRegistry composition |
| `create-hooks.ts` | 5-tier composition: `createCoreHooks() + createContinuationHooks() + createSkillHooks()` |
| `create-runtime-tmux-config.ts` | `isTmuxIntegrationEnabled()` + `createRuntimeTmuxConfig()` |

## INITIALIZATION FLOW

```
pluginModule.server(input, options)   # serverPlugin() in packages/omo-opencode/src/testing/create-plugin-module.ts
  ├─→ installAgentSortShim()          # patches Array.prototype.{toSorted,sort} for canonical agent ordering
  ├─→ initConfigContext()             # opencode-vs-openagent layout flag
  ├─→ logLegacyPluginStartupWarning() # warn if loaded under the legacy oh-my-opencode entry
  ├─→ migrateLegacyWorkspaceDirectory() # copy .sisyphus/ state forward to .omo/ on first load
  ├─→ detectDuplicateOmoPlugin()      # early-exit if a duplicate omo/openagent plugin is detected
  ├─→ detectExternalSkillPlugin()     # warn on conflicts
  ├─→ injectServerAuthIntoClient()    # auth headers into shared SDK client
  ├─→ loadPluginConfig()              # JSONC parse → user/project merge → Zod validate → migrate
  ├─→ recordPluginTelemetry()         # plugin-load telemetry
  ├─→ ensureTuiPluginEntry()          # if tui.sidebar.enabled !== false
  ├─→ initLiveServerRoute() + setLiveParentWakeRoutingDisabled() + warmLiveServerProbe()  # live-listener wake routing
  ├─→ selectRuntimeSecuritySkills() + createRuntimeSkillSourceServer()  # runtime security-skill source
  ├─→ initI18n()                      # load locale strings (packages/omo-opencode/src/locales/)
  ├─→ setAgentSortOrder()             # apply configured agent_order
  ├─→ initializeOpenClaw()            # if openclaw config present
  ├─→ checkTeamModeDependencies()     # if team_mode.enabled (try/catch → disabled-skills warning)
  ├─→ startTmuxCheck()                # if tmux integration enabled
  ├─→ createManagers()                # + createModelCacheState / createRuntimeTmuxConfig / first-message gate
  ├─→ createTools()                   # SkillContext + AvailableCategories + ToolRegistry
  ├─→ createHooks()                   # 5-tier: Session + ToolGuard + Transform + Continuation + Skill
  ├─→ createPluginInterface()         # 12 OpenCode hook handlers → PluginInterface
  └─→ createPluginDispose()           # final pluginHooks adds session.compacting + compaction.autocontinue + dispose
```

## 14 OPENCODE HOOK HANDLERS

12 wired in [`plugin-interface.ts`](plugin-interface.ts) + 2 wired directly in [`testing/create-plugin-module.ts`](testing/create-plugin-module.ts) (`experimental.session.compacting` + `experimental.compaction.autocontinue`).

| Handler | OpenCode Hook | Purpose |
|---------|---------------|---------|
| `config` | `config` | 6-phase pipeline: provider → plugin-components → agents → tools → MCPs → commands |
| `tool` | `tool` | 13-40 registered tools (config-gated: team-mode +12, monitor +4, task system +4, hashline +1, interactive_bash +1, look_at +1, goal +3, record_lesson +1) |
| `tool.definition` | `tool.definition` | Per-tool definition transform (applies `todo-description-override`) |
| `chat.message` | `chat.message` | First-message variant, session setup, keyword detection (ultrawork/search/analyze/team) |
| `chat.params` | `chat.params` | Anthropic effort, think mode, runtime fallback override |
| `chat.headers` | `chat.headers` | Copilot `x-initiator` header injection |
| `command.execute.before` | `command.execute.before` | Pre-command guards (slash-command interception, etc.) |
| `event` | `event` | Session lifecycle (created/deleted/idle/error), openclaw dispatch, runtime fallback |
| `tool.execute.before` | `tool.execute.before` | Pre-tool guards (write-existing-guard, label-truncator, rules-injector, prometheus-md-only, …) |
| `tool.execute.after` | `tool.execute.after` | Post-tool hooks (output truncator, comment-checker, hashline read-enhancer, json-error-recovery, …) |
| `experimental.chat.messages.transform` | `experimental.chat.messages.transform` | Context injection, thinking-block validation, tool-pair validation, keyword detection |
| `experimental.chat.system.transform` | `experimental.chat.system.transform` | System-message-level transforms |
| `experimental.session.compacting` | `experimental.session.compacting` | Context + todo preservation across compaction |
| `experimental.compaction.autocontinue` | `experimental.compaction.autocontinue` | Auto-resume after compaction completes |

## TOOL CATALOG (config-gated)

**Always on (13 registry tools):** `grep`, `glob`, `session_list`, `session_read`, `session_search`, `session_info`, `background_output`, `background_cancel`, `report_blocked`, `call_omo_agent`, `task` (delegate), `skill`, `skill_mcp`.

> Note: the 8 LSP aliases (`lsp_status`, `lsp_diagnostics`, `lsp_goto_definition`, `lsp_find_references`, `lsp_symbols`, `lsp_prepare_rename`, `lsp_rename`, `lsp_install_decision`) are NOT registry registrations, they are served by the built-in `lsp` MCP via [`packages/lsp-tools-mcp`](../../lsp-tools-mcp). Structural search and rewrite is provided by the `ast-grep` skill using `sg`.

**Conditional (up to 40 total):** `look_at` (+1, multimodal-looker not disabled), `interactive_bash` (+1, `tmux` binary available on PATH via `isInteractiveBashEnabled()`), `monitor_start`/`monitor_stop`/`monitor_list`/`monitor_output` (+4, `monitor.enabled`), `task_create`/`task_get`/`task_list`/`task_update` (+4, `experimental.task_system`), `edit` (+1, `hashline_edit`), `team_create`/`team_delete`/`team_shutdown_request`/`team_approve_shutdown`/`team_reject_shutdown`/`team_send_message`/`team_task_create`/`team_task_list`/`team_task_update`/`team_task_get`/`team_status`/`team_list` (+12, `team_mode.enabled`), `create_goal`/`update_goal`/`get_goal` (+3, `goal.enabled`), `record_lesson` (+1, `lessons.enabled`).

## CONFIG LOADING (Phase pipeline)

```
loadPluginConfig(directory, ctx)
  1. User: ~/.omo/omo.jsonc
  2. Walked configs: <pwd up to $HOME>/.omo/omo.jsonc
  3. mergeConfigs(user, walked)
     - agents/categories/claude_code: deepMerge (recursive, prototype-pollution safe)
     - disabled_*: Set union
     - mcp_env_allowlist: user-only (security)
     - playwright_mcp_args: user-only (security)
     - others: override replaces
  4. Zod safeParse → defaults for omitted fields
  5. Legacy configuration is migrated once at startup into the unified OMO chain
```

## HOOK COMPOSITION (5-tier)

Counts verified against each composer's actual return object (`plugin/hooks/create-session-hooks.ts`, `create-tool-guard-hooks.ts`, `create-transform-hooks.ts`, `create-continuation-hooks.ts`, `create-skill-hooks.ts`).

```
createHooks()
  ├─→ createCoreHooks()
  │   ├─ createSessionHooks()     # 26: preemptiveCompaction,
  │   │                             sessionNotification, thinkMode, modelFallback,
  │   │                             anthropicContextWindowLimitRecovery, autoUpdateChecker,
  │   │                             codegraphBootstrap, astGrepSgProvision,
  │   │                             agentUsageReminder, nonInteractiveEnv, interactiveBashSession,
  │   │                             goal, lessonNudge, unpolledShellJob, editErrorRecovery,
  │   │                             delegateTaskRetry, startWork, prometheusMdOnly,
  │   │                             sisyphusJuniorNotepad, noSisyphusGpt, noHephaestusNonGpt,
  │   │                             hephaestusAgentsMdInjector, questionLabelTruncator,
  │   │                             taskResumeInfo, runtimeFallback, legacyPluginToast
  │   ├─ createToolGuardHooks()   # 18: commentChecker, toolOutputTruncator,
  │   │                             directoryAgentsInjector, directoryReadmeInjector,
  │   │                             emptyTaskResponseDetector, rulesInjector, tasksTodowriteDisabler,
  │   │                             writeExistingFileGuard, bashFileReadGuard, hashlineReadEnhancer,
  │   │                             jsonErrorRecovery, readImageResizer, todoDescriptionOverride,
  │   │                             webfetchRedirectGuard, fsyncSkipWarning, teamToolGating,
  │   │                             notepadWriteGuard, planFormatValidator
  │   └─ createTransformHooks()   # 7: claudeCodeHooks, keywordDetector,
  │                                  contextInjectorMessagesTransform, teamModeStatusInjector,
  │                                  teamMailboxInjector, toolPairValidator, monitorStatusInjector
  ├─→ createContinuationHooks()   # 7: stopContinuationGuard, compactionContextInjector,
  │                                  compactionTodoPreserver, todoContinuationEnforcer (boulder),
  │                                  unstableAgentBabysitter, backgroundNotificationHook, atlasHook
  └─→ createSkillHooks()          # 2: categorySkillReminder, autoSlashCommand

  Direct event handlers (plugin/event-team-handlers.ts, wired when team_mode.enabled): +4
    team-idle-wake-hint, team-lead-orphan-handler,
    team-member-error-handler, team-member-status-handler
```

Session (26) + ToolGuard (18) + Transform (7) + Continuation (7) + Skill (2) = **60 composed hook slots**. 8 of those are config-gated null by default: session-tier `preemptiveCompaction` (`experimental.preemptive_compaction`), `modelFallback` (`model_fallback`, default off), `goal` (`goal.enabled`), `lessonNudge` (`lessons.enabled` + `lessons.nudge`), `interactiveBashSession` (null when tmux integration is off); transform-tier `teamModeStatusInjector` and `teamMailboxInjector` (`team_mode.enabled`) and `monitorStatusInjector` (`monitor.enabled`) → **52 active on default config**. `teamToolGating` is always composed and self-gates internally on `config.enabled`, so it counts as active. Team mode also adds the +4 direct event handlers above → **64 max**. Each tier produces an object whose values are `(input, output) => void` handlers; the matching OpenCode handler invokes them in registration order via `safeHook()` wrappers.

## SUBSYSTEM INVENTORY

| Subdir | Purpose | Has AGENTS.md |
|--------|---------|---------------|
| `agents/` | 11 agent factories + dynamic prompt builder | yes (+ atlas, hephaestus, prometheus, sisyphus, sisyphus-junior, builtin-agents) |
| `hooks/` | 52-64 lifecycle hooks (see ## HOOK COMPOSITION above) across 64 dirs | yes (+ atlas, anthropic-context-window-limit-recovery, auto-update-checker, claude-code-hooks, comment-checker, compaction-context-injector, keyword-detector, ralph-loop, rules-injector, runtime-fallback, todo-continuation-enforcer) |
| `tools/` | 14 native tool dirs (+1 shared utilities dir); LSP + AST-grep moved to built-in MCPs | yes (+ background-task, call-omo-agent, delegate-task, hashline-edit, look-at, record-lesson, skill) |
| `features/` | 23 feature modules (some now shimming `team-core`, `tmux-core`, `skills-loader-core`, `mcp-client-core`, and `claude-code-compat-core`) | yes (+ 11 sub-AGENTS.md including builtin-skills, team-mode, background-agent, claude-code-*) |
| `shared/` | Cross-cutting adapter utilities plus shims over extracted Core packages, barrel-exported | yes |
| `cli/` | Commander.js CLI: install, run, doctor, mcp-oauth, boulder | yes (+ config-manager, doctor, run) |
| `plugin/` | 12 OpenCode hook handlers + hook composition | yes |
| `config/` | Zod v4 schema files | yes |
| `plugin-handlers/` | 6-phase config loading pipeline | yes |
| `openclaw/` | Bidirectional Discord/Telegram/HTTP integration | yes |
| `__tests__/` | Plugin-level integration tests + perf fixtures | yes |
| `mcp/` | 5 built-in MCPs (3 remote + local stdio lsp + codegraph) | yes |
| `testing/` | Test utilities + `create-plugin-module.ts` | yes |
| `config-migration/` | Legacy config discovery + transform plans (consumed by senpi config-startup + codex startup) | yes |
| `types/` | Ambient `.d.ts` declarations (markdown modules) | no |
| `help/` | CLI help schema definitions (acp, doctor, sandbox, status) | no |
| `locales/` | i18n strings (en, zh): toasts + model-fallback labels | no |

## NOTES

- `plugin-interface.ts` is the **only** layer that talks to OpenCode's `Plugin` API. Every other file goes through it.
- Reach for `shared/` before adding helpers anywhere else; duplicate utilities WILL be flagged in review.
- Path aliases are forbidden. Use relative imports within a module, barrel imports across modules.
