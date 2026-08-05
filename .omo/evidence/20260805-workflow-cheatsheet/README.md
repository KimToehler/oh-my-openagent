# Workflow cheatsheet QA evidence

## What was tested

- TDD red run: `bun test packages/omo-opencode/src/features/tui-sidebar packages/omo-opencode/src/config/schema/oh-my-opencode-config.test.ts`
  - Before production code: 68 passed, 5 failed. Failures showed missing `workflow_cheatsheet` defaults/parse and missing `Workflow` rendering.
- Focused green run: same command.
  - 73 passed, 0 failed, 139 assertions.
- Schema generation: `bun run build:schema`.
  - Generated `assets/oh-my-opencode.schema.json` with `workflow_cheatsheet`, boolean default `false`.
- Type verification: `bun run typecheck`.
  - `tsgo --noEmit`, script typecheck, and all package typechecks passed.
- Build: `bun run build`.
  - Completed all build steps.
- Real OpenCode TUI smoke: `bash .agents/skills/opencode-qa/scripts/tui-smoke.sh --self-test`.
  - Isolated TUI rendered under tmux using OpenCode 1.18.5.
  - `send-keys` reached composer.
  - tmux session removed.
  - Real DB session count remained 1147 before and after.

## What was observed

- Config defaults remain `tui.sidebar.enabled: true`; new `tui.sidebar.workflow_cheatsheet: false`.
- Enabled active view renders `Workflow` after `ULW` and before `Agents`.
- Section contains exactly: `ulw`, `ulw-plan`, `start-work`, `hyperplan`, `work-with-pr`, `review-work`, `full-code-review`.
- Disabled active view omits section.
- Existing broken and idle rendering paths remain unchanged; focused suite covers both.
- No `codex-qa` or Codex-specific entry appears.

## Why this is enough

- Schema tests prove default and opt-in parsing.
- Compute/render tests prove active-only gate, exact content, and required ordering while retaining idle/broken coverage.
- Typecheck and build cover integration with plugin TUI entry.
- Isolated real TUI smoke proves plugin TUI still boots, renders, accepts input, cleans up, and does not alter host OpenCode DB.

## What was omitted

- No Codex QA, per scope.
- No PR or commit.
- No secret-bearing logs, environment dumps, tokens, or auth headers captured.
- LSP diagnostics unavailable because configured LSP could not find a TypeScript installation; repository-native `bun run typecheck` passed instead.
