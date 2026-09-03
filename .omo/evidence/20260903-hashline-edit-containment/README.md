# Hashline edit containment QA evidence

## WHAT WAS TESTED

- OpenCode `1.18.20`, isolated XDG sandbox, loaded OMO plugin, `hashline_edit: true`, no disabled tools, `experimental.max_tools: 128`, and `Sisyphus - ultraworker` primary agent.
- Contrast runtime runs: plugin config on/off and write-capable versus read-only agent request surfaces.
- Disposable `git clone --no-local` fixture: committed `MAIN_BASELINE` before `git worktree add`; linked worktree carried uncommitted `WORKTREE_BASELINE`.
- Cases 1-4 via real `executeHashlineEditTool` boundary after host runtime omitted OMO `edit`: absolute internal update, denied external main-like clone update, relative update, denied external rename destination.

## WHAT WAS OBSERVED

- OMO module loaded. `exposure-plugin.log` reports `[tool-registry] Built tool registry {"totalTools":16,"teamModeEnabled":false,"teamToolCount":0}`.
- `exposure-write-capable-request.json` contains native `apply_patch` and zero `"name":"edit"` entries despite resolved hashline-on config and write-capable primary agent.
- `05-sse-reprobe.ndjson` records `Model tried to call unavailable tool 'edit'` under prior runtime attempt.
- Executor cases passed containment outcomes in `50-executor-disposable-clone-cases.json`: Case 1 updates only linked worktree; Case 2 asks then denial preserves main-like clone; Case 3 resolves relative path through `context.directory`; Case 4 asks for rename destination then denial preserves source and destination absence.
- Primary checkout status SHA-256 was unchanged: `ba0e86efbb66bf04465ce442095ce320fbaa7dba2bfaf1d165591a00f05daeb1` before and after sandbox activity.

## WHY IT IS ENOUGH

Runtime collision blocks tool-level routing proof on tested OpenCode 1.18.20. Executor directly owns resolved path authorization and filesystem mutation, so controlled real ToolContext fixture covers containment semantics while retaining runtime collision scope limit.

## WHAT WAS OMITTED

No claim that host OpenCode routed a live `edit` call to OMO. No credentials, environment dump, or raw host sessions included.
