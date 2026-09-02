# WHAT WAS TESTED

- `bun test packages/omo-opencode/src/features/background-agent/blocked-retention.test.ts` before production edits, then after both purge-path fixes.
- Fake timers cover manager scheduled cleanup at 10 minutes, poller terminal TTL at 30 minutes, hard expiry, and ordinary cancelled-task cleanup.
- `bun test packages/omo-opencode/src/features/background-agent/ packages/omo-opencode/src/tools/background-task/ packages/omo-opencode/src/tools/report-blocked/ packages/omo-opencode/src/shared/prompt-async-route-audit.test.ts`.
- `bun run typecheck`.

# WHAT WAS OBSERVED

## RED

```text
bun test v1.3.14 (d1632b29)

packages/omo-opencode/src/features/background-agent/blocked-retention.test.ts:
91 | 
92 |       // when
93 |       jest.advanceTimersByTime(TASK_CLEANUP_DELAY_MS + 1)
94 | 
95 |       // then
96 |       expect(managerUnderTest.findBySession(task.sessionId ?? "")).toBe(task)
                                                                        ^
error: expect(received).toBe(expected)

Expected: {
  id: "task-blocked",
  sessionId: "session-blocked",
  parentSessionId: "session-parent",
  parentMessageId: "message-parent",
  description: "blocked task",
  prompt: "wait for parent answer",
  agent: "test-agent",
  status: "cancelled",
  startedAt: 2026-08-08T23:59:59.000Z,
  completedAt: 2026-08-09T00:00:00.000Z,
  blockedAt: 2026-08-09T00:00:00.000Z,
  blockedReason: "Need input",
}
Received: undefined

      at <anonymous> (/Users/tim/git/oh-my-openagent/.worktrees/subagent-blocked-report/packages/omo-opencode/src/features/background-agent/blocked-retention.test.ts:96:68)
(fail) blocked task retention > #given manager cleanup is scheduled > #then keeps a blocked task after the normal cleanup delay [1.26ms]
143 | 
144 |       // when
145 |       prune(tasks)
146 | 
147 |       // then
148 |       expect(tasks.get(task.id)).toBe(task)
                                       ^
error: expect(received).toBe(expected)

Expected: {
  id: "task-blocked",
  sessionId: "session-blocked",
  parentSessionId: "session-parent",
  parentMessageId: "message-parent",
  description: "blocked task",
  prompt: "wait for parent answer",
  agent: "test-agent",
  status: "cancelled",
  startedAt: 2026-08-09T00:29:59.001Z,
  completedAt: 2026-08-09T00:00:00.000Z,
  blockedAt: 2026-08-09T00:30:00.001Z,
  blockedReason: "Need input",
}
Received: undefined

      at <anonymous> (/Users/tim/git/oh-my-openagent/.worktrees/subagent-blocked-report/packages/omo-opencode/src/features/background-agent/blocked-retention.test.ts:148:34)
(fail) blocked task retention > #given terminal TTL pruning runs > #then keeps an old terminal task while its block is within the expiry window [0.16ms]

 2 pass
 2 fail
 4 expect() calls
Ran 4 tests across 1 file. [85.00ms]
```

## GREEN

```text
bun test v1.3.14 (d1632b29)

 4 pass
 0 fail
 4 expect() calls
Ran 4 tests across 1 file. [86.00ms]
```

## ACCEPTANCE SUITE

```text
bun test v1.3.14 (d1632b29)

 895 pass
 0 fail
 2346 expect() calls
Ran 895 tests across 89 files. [32.21s]
```

## TYPECHECK

```text
$ tsgo --noEmit && bun run typecheck:script && bun run typecheck:packages
$ tsgo --noEmit -p script/tsconfig.json
$ tsgo --noEmit -p packages/rules-engine/tsconfig.json && tsgo --noEmit -p packages/delegate-core/tsconfig.json && tsgo --noEmit -p packages/mcp-stdio-core/tsconfig.json && tsgo --noEmit -p packages/mcp-client-core/tsconfig.json && tsgo --noEmit -p packages/git-bash-mcp/tsconfig.json && tsgo --noEmit -p packages/lsp-core/tsconfig.json && tsgo --noEmit -p packages/utils/tsconfig.json && tsgo --noEmit -p packages/model-core/tsconfig.json && tsgo --noEmit -p packages/omo-config-core/tsconfig.json && tsgo --noEmit -p packages/prompts-core/tsconfig.json && tsgo --noEmit -p packages/comment-checker-core/tsconfig.json && tsgo --noEmit -p packages/hashline-core/tsconfig.json && tsgo --noEmit -p packages/tmux-core/tsconfig.json && tsgo --noEmit -p packages/team-core/tsconfig.json && tsgo --noEmit -p packages/openclaw-core/tsconfig.json && tsgo --noEmit -p packages/boulder-state/tsconfig.json && tsgo --noEmit -p packages/telemetry-core/tsconfig.json && tsgo --noEmit -p packages/claude-code-compat-core/tsconfig.json && tsgo --noEmit -p packages/skills-loader-core/tsconfig.json && tsgo --noEmit -p packages/agents-md-core/tsconfig.json && tsgo --noEmit -p packages/omo-codex/plugin/shared/tsconfig.json && tsgo --noEmit -p packages/omo-codex/tsconfig.json && tsgo --noEmit -p packages/omo-senpi/tsconfig.json && tsgo --noEmit -p packages/senpi-task/tsconfig.json && tsgo --noEmit -p packages/pi-goal/tsconfig.json && tsgo --noEmit -p packages/pi-webfetch/tsconfig.json && tsgo --noEmit -p packages/omo-opencode/tsconfig.json
```

# WHY IT IS ENOUGH

- RED failed only retention assertions: manager cleanup deleted blocked task after normal delay, and poller TTL deleted blocked task while block remained within expiry window.
- GREEN proves both independent purge paths retain blocked tasks only while `isTaskBlocked(task)` and `blockedAt + blockedExpiryMs` remain live.
- Hard-expiry case proves bounded retention. Ordinary cancelled-task case proves no cleanup regression for non-blocked tasks.
- Typecheck covers production and test types across repository packages.

# WHAT WAS OMITTED

- No real OpenCode harness QA in Todo 7. Final plan wave owns end-to-end `report_blocked` park, wake, answer, and resume QA.
- No secrets, environment dumps, auth headers, or private credentials captured.

## MUTATION-COVERAGE FIX

Added mirrored terminal-TTL poller test for a blocked task exactly at hard expiry. Production logic unchanged.

### MUTATED RED

```text
bun test v1.3.14 (d1632b29)

packages/omo-opencode/src/features/background-agent/blocked-retention.test.ts:
164 | 
165 |       // when
166 |       prune(tasks)
167 | 
168 |       // then
169 |       expect(tasks.has(task.id)).toBe(false)
                                       ^
error: expect(received).toBe(expected)

Expected: false
Received: true

      at <anonymous> (/Users/tim/git/oh-my-openagent/.worktrees/subagent-blocked-report/packages/omo-opencode/src/features/background-agent/blocked-retention.test.ts:169:34)
(fail) blocked task retention > #given terminal TTL pruning runs > #then removes an old terminal task once its block reaches hard expiry [0.16ms]

 4 pass
 1 fail
 5 expect() calls
Ran 5 tests across 1 file. [85.00ms]
```

### RESTORED GREEN

```text
bun test v1.3.14 (d1632b29)

 5 pass
 0 fail
 5 expect() calls
Ran 5 tests across 1 file. [78.00ms]
```
