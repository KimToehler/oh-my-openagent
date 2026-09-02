# Todo 8: blocked background_output

## WHAT WAS TESTED

- `bun test packages/omo-opencode/src/tools/background-task/create-background-output.test.ts` before production changes.
- `bun test packages/omo-opencode/src/tools/background-task/` after implementation.
- `bun run typecheck` after implementation.
- `lsp_diagnostics` on all four changed TypeScript files.
- Direct `formatTaskStatus` render for blocked task.

## WHAT WAS OBSERVED

### RED

```text
bun test v1.3.14 (d1632b29)

packages/omo-opencode/src/tools/background-task/create-background-output.test.ts:
67 | 
68 |     // when
69 |     const output = await outputTool.execute({ task_id: task.id }, toolContext)
70 | 
71 |     // then
72 |     expect(output).toContain("BLOCKED")
                        ^
error: expect(received).toContain(expected)

Expected to contain: "BLOCKED"
Received: "# Task Status\n\n| Field | Value |\n|-------|-------|\n| Task ID | `bg_blocked` |\n| Description | blocked child |\n| Agent | test-agent |\n| Status | **cancelled** |\n| Duration | 1m 0s |\n| Session ID | `ses_child` |\n\n## Original Prompt\n\n```\nfinish task\n```"

      at <anonymous> (/Users/tim/git/oh-my-openagent/.worktrees/subagent-blocked-report/packages/omo-opencode/src/tools/background-task/create-background-output.test.ts:72:20)
(fail) createBackgroundOutput blocked task rendering > #given a blocked task #when output is requested #then it shows the reason and answer instruction [3.22ms]
125 |       toolContext,
126 |     )
127 | 
128 |     // then
129 |     expect(lookupCount).toBe(1)
130 |     expect(output).toContain("BLOCKED")
                         ^
error: expect(received).toContain(expected)

Expected to contain: "BLOCKED"
Received: "# Task Status\n\n| Field | Value |\n|-------|-------|\n| Task ID | `bg_blocked` |\n| Description | blocked child |\n| Agent | test-agent |\n| Status | **cancelled** |\n| Duration | 1m 0s |\n| Session ID | `ses_child` |\n\n## Original Prompt\n\n```\nfinish task\n```"

      at <anonymous> (/Users/tim/git/oh-my-openagent/.worktrees/subagent-blocked-report/packages/omo-opencode/src/tools/background-task/create-background-output.test.ts:130:20)
(fail) createBackgroundOutput blocked task rendering > #given a blocked task #when block=true is requested #then it returns without polling [0.31ms]

 1 pass
 2 fail
 4 expect() calls
Ran 3 tests across 1 file. [171.00ms]
```

### GREEN

```text
bun test v1.3.14 (d1632b29)

 65 pass
 0 fail
 156 expect() calls
Ran 65 tests across 14 files. [1148.00ms]
```

### Typecheck

```text
$ tsgo --noEmit && bun run typecheck:script && bun run typecheck:packages
packages/omo-opencode/src/features/background-agent/background-task-notification-template.ts(120,35): error TS2739: Type 'BackgroundTaskNotificationTask' is missing the following properties from type 'BackgroundTask': parentSessionId, parentMessageId, prompt, agent
```

Typecheck did not exit 0 because concurrent Todo 4 edits in `background-task-notification-template.ts` pass `BackgroundTaskNotificationTask` to `isTaskBlocked()`, which requires full `BackgroundTask`. Todo 8 files are disjoint and were not changed to mask this external error.

### LSP diagnostics

```text
Request initialize failed with message: Could not find a valid TypeScript installation. Please ensure that the "typescript" dependency is installed in the workspace or that a valid `tsserver.path` is specified. Exiting.
```

All four changed files produced same initialization failure. Repository typecheck reached TypeScript analysis and reported only concurrent Todo 4 error above.

### Rendered blocked output

```text
# Task Status

| Field | Value |
|-------|-------|
| Task ID | `bg_blocked` |
| Description | blocked child |
| Agent | test-agent |
| Status | **BLOCKED** |
| Duration | 1m 0s |
| Session ID | `ses_child` |


> **BLOCKED**: Need deployment target
>
> Answer with `task(task_id="ses_child", prompt="...")`.
## Original Prompt

```
finish task
```
```

## WHY IT IS ENOUGH

- Blocked test proves marker, reason, and shared answer instruction render through public tool output.
- Plain cancelled test pins exact legacy output, preventing blocked handling from changing non-blocked cancellation.
- `block=true` test uses 600000ms timeout and proves one manager lookup, pinning immediate return and anti-deadlock predicate.
- Full background-task directory suite passed: 65 tests, 0 failures.

## WHAT WAS OMITTED

- No OpenCode live-harness QA. Todo scope is pure output formatting, and user acceptance named unit suite plus typecheck.
- No edits, staging, or cleanup of concurrent Todo 4 files.
- No secrets, environment dumps, auth headers, or private credentials captured.
