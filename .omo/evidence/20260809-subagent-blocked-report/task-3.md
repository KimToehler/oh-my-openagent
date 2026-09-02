# Todo 3: report_blocked tool

## WHAT WAS TESTED

- TDD RED: `bun test packages/omo-opencode/src/tools/report-blocked/`
- TDD GREEN: `bun test packages/omo-opencode/src/tools/report-blocked/`
- Registry: `bun test packages/omo-opencode/src/plugin/tool-registry.test.ts`
- Background-agent regression and prompt-route audit: `bun test packages/omo-opencode/src/features/background-agent/ packages/omo-opencode/src/shared/prompt-async-route-audit.test.ts`
- Type safety: `bun run typecheck`
- LSP diagnostics requested for every changed TypeScript path.

## WHAT WAS OBSERVED

### RED, verbatim

```text
bun test v1.3.14 (d1632b29)

packages/omo-opencode/src/tools/report-blocked/tools.test.ts:

# Unhandled error between tests
-------------------------------
error: Cannot find module './tools' from '/Users/tim/git/oh-my-openagent/.worktrees/subagent-blocked-report/packages/omo-opencode/src/tools/report-blocked/tools.test.ts'
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [196.00ms]
```

Failure reason was expected: test existed before `tools.ts` implementation.

### GREEN, verbatim

```text
bun test v1.3.14 (d1632b29)

 3 pass
 0 fail
 13 expect() calls
Ran 3 tests across 1 file. [85.00ms]
```

### Load-bearing call-order assertion

Test assertion:

```typescript
expect(calls).toEqual(["notify", "cancel"])
```

GREEN output above proves this assertion passed. Test also asserts exact cancel options:

```typescript
expect(cancelTask).toHaveBeenCalledWith("task_child", {
  source: "report_blocked",
  reason: task.blockedReason,
  abortSession: true,
  skipNotification: true,
})
```

### Registry, verbatim

```text
bun test v1.3.14 (d1632b29)

 10 pass
 0 fail
 32 expect() calls
Ran 10 tests across 1 file. [127.00ms]
```

### Background-agent regression and prompt-route audit, verbatim

```text
bun test v1.3.14 (d1632b29)

 814 pass
 0 fail
 2150 expect() calls
Ran 814 tests across 72 files. [30.73s]
```

### Typecheck, verbatim

```text
$ tsgo --noEmit && bun run typecheck:script && bun run typecheck:packages
$ tsgo --noEmit -p script/tsconfig.json
$ tsgo --noEmit -p packages/rules-engine/tsconfig.json && tsgo --noEmit -p packages/delegate-core/tsconfig.json && tsgo --noEmit -p packages/mcp-stdio-core/tsconfig.json && tsgo --noEmit -p packages/mcp-client-core/tsconfig.json && tsgo --noEmit -p packages/git-bash-mcp/tsconfig.json && tsgo --noEmit -p packages/lsp-core/tsconfig.json && tsgo --noEmit -p packages/utils/tsconfig.json && tsgo --noEmit -p packages/model-core/tsconfig.json && tsgo --noEmit -p packages/omo-config-core/tsconfig.json && tsgo --noEmit -p packages/prompts-core/tsconfig.json && tsgo --noEmit -p packages/comment-checker-core/tsconfig.json && tsgo --noEmit -p packages/hashline-core/tsconfig.json && tsgo --noEmit -p packages/tmux-core/tsconfig.json && tsgo --noEmit -p packages/team-core/tsconfig.json && tsgo --noEmit -p packages/openclaw-core/tsconfig.json && tsgo --noEmit -p packages/boulder-state/tsconfig.json && tsgo --noEmit -p packages/telemetry-core/tsconfig.json && tsgo --noEmit -p packages/claude-code-compat-core/tsconfig.json && tsgo --noEmit -p packages/skills-loader-core/tsconfig.json && tsgo --noEmit -p packages/agents-md-core/tsconfig.json && tsgo --noEmit -p packages/omo-codex/plugin/shared/tsconfig.json && tsgo --noEmit -p packages/omo-codex/tsconfig.json && tsgo --noEmit -p packages/omo-senpi/tsconfig.json && tsgo --noEmit -p packages/senpi-task/tsconfig.json && tsgo --noEmit -p packages/pi-goal/tsconfig.json && tsgo --noEmit -p packages/pi-webfetch/tsconfig.json && tsgo --noEmit -p packages/omo-opencode/tsconfig.json
```

Exit code: 0.

### LSP diagnostics

Every diagnostics request failed before analysis because configured LSP could not find a valid TypeScript installation:

```text
Request initialize failed with message: Could not find a valid TypeScript installation. Please ensure that the "typescript" dependency is installed in the workspace or that a valid `tsserver.path` is specified. Exiting.
```

`bun run typecheck` completed successfully as compiler-backed verification.

## WHY IT IS ENOUGH

- Unit tests pin amended ordering: blocked metadata set, parent notification issued first, child cancellation issued second.
- Exact cancellation options pin `abortSession: true` and `skipNotification: true`, preventing duplicate wake dispatch.
- Failure tests pin non-background rejection without cancellation and abort failure reporting that parent was notified while child remains running.
- Registry test proves tool is callable after registry construction.
- Prompt builder advertises machine-consumed tool name to delegated children.
- 814-test regression gate proves no raw prompt-route or background-manager regression.
- Full repo typecheck proves changed interfaces and registry wiring compile.

## WHAT WAS OMITTED

- No secret-bearing logs, environment dumps, tokens, auth headers, or credentials captured.
- No real-harness QA in Todo 3. Plan assigns real self-abort harness proof to F3.
- No generated build artifacts retained.

## REGRESSION FIX

### Root cause

`buildSystemContent()` appended the `report_blocked` advertisement unconditionally. That function serves sync, plan, team, continuation, and background paths, so unrelated system content changed. Existing `run_in_background` routing already selects `executeBackgroundTask()`. Fix moved advertisement to `buildBackgroundTaskPrompt()`, called only from that background execution path. Existing byte-identity assertions remain unchanged.

### Delegate-task RED, verbatim

```text
bun test v1.3.14 (d1632b29)

 488 pass
 12 fail
 1172 expect() calls
Ran 500 tests across 43 files. [2.13s]
```

All 12 failures reported unconditional `<background-subagent-tools>` content in unrelated `buildSystemContent()` outputs.

### Added background-path test RED

```text
bun test v1.3.14 (d1632b29)

 7 pass
 3 fail
 22 expect() calls
Ran 10 tests across 1 file. [81.00ms]
```

New test calls the background-only prompt builder and asserts machine-consumed token `report_blocked`. Existing failures remained until production fix.

### Delegate-task GREEN, verbatim

```text
bun test v1.3.14 (d1632b29)

 501 pass
 0 fail
 1177 expect() calls
Ran 501 tests across 43 files. [2.14s]
```

### Combined regression gate, verbatim

```text
bun test v1.3.14 (d1632b29)

 900 pass
 0 fail
 2360 expect() calls
Ran 900 tests across 90 files. [31.78s]
```

Command:

```text
bun test packages/omo-opencode/src/features/background-agent/ packages/omo-opencode/src/tools/background-task/ packages/omo-opencode/src/tools/report-blocked/ packages/omo-opencode/src/shared/prompt-async-route-audit.test.ts
```

### Typecheck, verbatim

```text
$ tsgo --noEmit && bun run typecheck:script && bun run typecheck:packages
$ tsgo --noEmit -p script/tsconfig.json
$ tsgo --noEmit -p packages/rules-engine/tsconfig.json && tsgo --noEmit -p packages/delegate-core/tsconfig.json && tsgo --noEmit -p packages/mcp-stdio-core/tsconfig.json && tsgo --noEmit -p packages/mcp-client-core/tsconfig.json && tsgo --noEmit -p packages/git-bash-mcp/tsconfig.json && tsgo --noEmit -p packages/lsp-core/tsconfig.json && tsgo --noEmit -p packages/utils/tsconfig.json && tsgo --noEmit -p packages/model-core/tsconfig.json && tsgo --noEmit -p packages/omo-config-core/tsconfig.json && tsgo --noEmit -p packages/prompts-core/tsconfig.json && tsgo --noEmit -p packages/comment-checker-core/tsconfig.json && tsgo --noEmit -p packages/hashline-core/tsconfig.json && tsgo --noEmit -p packages/tmux-core/tsconfig.json && tsgo --noEmit -p packages/team-core/tsconfig.json && tsgo --noEmit -p packages/openclaw-core/tsconfig.json && tsgo --noEmit -p packages/boulder-state/tsconfig.json && tsgo --noEmit -p packages/telemetry-core/tsconfig.json && tsgo --noEmit -p packages/claude-code-compat-core/tsconfig.json && tsgo --noEmit -p packages/skills-loader-core/tsconfig.json && tsgo --noEmit -p packages/agents-md-core/tsconfig.json && tsgo --noEmit -p packages/omo-codex/plugin/shared/tsconfig.json && tsgo --noEmit -p packages/omo-codex/tsconfig.json && tsgo --noEmit -p packages/omo-senpi/tsconfig.json && tsgo --noEmit -p packages/senpi-task/tsconfig.json && tsgo --noEmit -p packages/pi-goal/tsconfig.json && tsgo --noEmit -p packages/pi-webfetch/tsconfig.json && tsgo --noEmit -p packages/omo-opencode/tsconfig.json
```

Exit code: 0.

### Remaining full-repo failures assessment

Command:

```text
bun test packages/omo-opencode/src/features/skills/ 2>/dev/null || true
```

Observed output:

```text
bun test v1.3.14 (d1632b29)
```

No skill test failures or test summary appeared for that path. Reported `skill loader MCP parsing`, `resolveSkillContentAsync`, and Codex-installer version-sync failures are independent of this fix: changed files are limited to delegate-task background prompt assembly, no skill loader parser, async skill resolver, installer, version, or Codex path changed. No attempt made to fix them.

### Diagnostics note

LSP initialization still cannot locate a valid TypeScript installation. `bun run typecheck` passed as compiler-backed verification.
