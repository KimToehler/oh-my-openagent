# Todo 6 Evidence

## WHAT WAS TESTED

- TDD target: `bun test packages/omo-opencode/src/features/background-agent/blocked-notify.test.ts`
- Regression suite: `bun test packages/omo-opencode/src/features/background-agent/`
- Prompt-gate audit: `bun test packages/omo-opencode/src/shared/prompt-async-route-audit.test.ts`
- Type safety: `bun run typecheck`
- OpenCode surface assessment: manager notification plumbing only. Real-harness self-abort QA remains assigned to plan F3 per AMENDMENT A1. No OpenCode process was spawned for this infrastructure todo.

## WHAT WAS OBSERVED

### RED, verbatim

```text
bun test v1.3.14 (d1632b29)

packages/omo-opencode/src/features/background-agent/blocked-notify.test.ts:
72 |       parentSessionIDs.push(parentSessionID)
73 |       await operation()
74 |     })
75 | 
76 |     // when
77 |     await manager.notifyBlockedTask(task.id)
                       ^
TypeError: manager.notifyBlockedTask is not a function. (In 'manager.notifyBlockedTask(task.id)', 'manager.notifyBlockedTask' is undefined)
      at <anonymous> (/Users/tim/git/oh-my-openagent/.worktrees/subagent-blocked-report/packages/omo-opencode/src/features/background-agent/blocked-notify.test.ts:77:19)
(fail) BackgroundManager blocked task notification > #given a task with blocked metadata #when notifyBlockedTask runs #then one wake targets its parent session [2.36ms]
91 |       wakeCount += 1
92 |       await operation()
93 |     })
94 | 
95 |     // when
96 |     await manager.notifyBlockedTask(task.id)
                       ^
TypeError: manager.notifyBlockedTask is not a function. (In 'manager.notifyBlockedTask(task.id)', 'manager.notifyBlockedTask' is undefined)
      at <anonymous> (/Users/tim/git/oh-my-openagent/.worktrees/subagent-blocked-report/packages/omo-opencode/src/features/background-agent/blocked-notify.test.ts:96:19)
(fail) BackgroundManager blocked task notification > #given one blocked task #when notifyBlockedTask runs twice #then only one wake is dispatched [0.28ms]
118 |     const cancelled = await manager.cancelTask(task.id, { abortSession: false, reason: task.blockedReason })
119 | 
120 |     // then
121 |     expect(cancelled).toBe(true)
122 |     expect(observedActive).toBe(false)
123 |     expect(observedPendingWake).toBe(true)
                                      ^
error: expect(received).toBe(expected)

Expected: true
Received: false

      at <anonymous> (/Users/tim/git/oh-my-openagent/.worktrees/subagent-blocked-report/packages/omo-opencode/src/features/background-agent/blocked-notify.test.ts:123:33)
(fail) BackgroundManager blocked task notification > #given a blocked running task #when cancelTask parks it #then notification preparation covers the terminal-to-wake window [2.45ms]
132 |     Reflect.set(manager, "notifyParentSession", async (notifiedTask: BackgroundTask) => {
133 |       renderedErrors.push(notifiedTask.error)
134 |     })
135 | 
136 |     // when
137 |     await manager.notifyBlockedTask(task.id)
                        ^
TypeError: manager.notifyBlockedTask is not a function. (In 'manager.notifyBlockedTask(task.id)', 'manager.notifyBlockedTask' is undefined)
      at <anonymous> (/Users/tim/git/oh-my-openagent/.worktrees/subagent-blocked-report/packages/omo-opencode/src/features/background-agent/blocked-notify.test.ts:137:19)
(fail) BackgroundManager blocked task notification > #given a blocked reason in task.error #when notifyBlockedTask runs #then notification rendering receives that error [0.17ms]

 0 pass
 4 fail
 3 expect() calls
Ran 4 tests across 1 file. [166.00ms]
```

### GREEN, verbatim

```text
bun test v1.3.14 (d1632b29)

 4 pass
 0 fail
 8 expect() calls
Ran 4 tests across 1 file. [228.00ms]
```

### Required acceptance output

Background-agent suite:

```text
bun test v1.3.14 (d1632b29)

 804 pass
 0 fail
 2140 expect() calls
Ran 804 tests across 71 files. [29.94s]
```

Prompt async route audit:

```text
bun test v1.3.14 (d1632b29)

 10 pass
 0 fail
 10 expect() calls
Ran 10 tests across 1 file. [1182.00ms]
```

Typecheck:

```text
$ tsgo --noEmit && bun run typecheck:script && bun run typecheck:packages
$ tsgo --noEmit -p script/tsconfig.json
$ tsgo --noEmit -p packages/rules-engine/tsconfig.json && tsgo --noEmit -p packages/delegate-core/tsconfig.json && tsgo --noEmit -p packages/mcp-stdio-core/tsconfig.json && tsgo --noEmit -p packages/mcp-client-core/tsconfig.json && tsgo --noEmit -p packages/git-bash-mcp/tsconfig.json && tsgo --noEmit -p packages/lsp-core/tsconfig.json && tsgo --noEmit -p packages/utils/tsconfig.json && tsgo --noEmit -p packages/model-core/tsconfig.json && tsgo --noEmit -p packages/omo-config-core/tsconfig.json && tsgo --noEmit -p packages/prompts-core/tsconfig.json && tsgo --noEmit -p packages/comment-checker-core/tsconfig.json && tsgo --noEmit -p packages/hashline-core/tsconfig.json && tsgo --noEmit -p packages/tmux-core/tsconfig.json && tsgo --noEmit -p packages/team-core/tsconfig.json && tsgo --noEmit -p packages/openclaw-core/tsconfig.json && tsgo --noEmit -p packages/boulder-state/tsconfig.json && tsgo --noEmit -p packages/telemetry-core/tsconfig.json && tsgo --noEmit -p packages/claude-code-compat-core/tsconfig.json && tsgo --noEmit -p packages/skills-loader-core/tsconfig.json && tsgo --noEmit -p packages/agents-md-core/tsconfig.json && tsgo --noEmit -p packages/omo-codex/plugin/shared/tsconfig.json && tsgo --noEmit -p packages/omo-codex/tsconfig.json && tsgo --noEmit -p packages/omo-senpi/tsconfig.json && tsgo --noEmit -p packages/senpi-task/tsconfig.json && tsgo --noEmit -p packages/pi-goal/tsconfig.json && tsgo --noEmit -p packages/pi-webfetch/tsconfig.json && tsgo --noEmit -p packages/omo-opencode/tsconfig.json
```

LSP diagnostics were attempted after `bun install`, but workspace LSP initialization still reported: `Could not find a valid TypeScript installation.` `bun run typecheck` provided compiler validation and exited 0.

## WHY IT IS ENOUGH

- Test (a) proves one `notifyBlockedTask` call queues exactly one notification for correct `parentSessionId`.
- Test (b) proves manager-owned idempotence prevents second dispatch before downstream wake dedupe.
- Test (c) observes cancel path after task becomes terminal and proves notification preparation remains visible during enqueue, preventing `no active children AND no pending wake` poller state.
- Test (d) proves `task.error`, carrying blocked reason, reaches notification rendering input unchanged.
- Full 71-file background-agent suite and static raw-prompt audit passed. Typecheck passed across root, scripts, and workspace packages.

## WHAT WAS OMITTED

- No provider credentials, auth headers, environment dumps, or private logs captured.
- No real OpenCode harness run for this infrastructure-only todo. AMENDMENT A1 assigns genuine child self-abort end-to-end proof to F3.
- No files outside Todo 6 source/test scope were staged or committed. Evidence lives in main checkout as explicitly required.
