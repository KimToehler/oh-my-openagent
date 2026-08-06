# Bounded Sync Delegation Blocker Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce one configured wall-clock budget for each synchronous delegation, including continuations, while safely transferring yielded continuations to background ownership.

**Architecture:** `runSyncTaskLoop()` computes one absolute deadline before fallback retry loop and passes it to each poll attempt. `pollSyncSession()` compares current time to supplied deadline but retains per-attempt inactivity tracking. `executeSyncContinuation()` computes same deadline, adopts live session through `BackgroundManager`, and skips sync handback cleanup only after adoption succeeds.

**Tech Stack:** TypeScript, Bun test, OpenCode SDK adapter.

## Global Constraints

- Preserve `Infinity` as inert no-bound default.
- Do not change inactivity timing, poll interval, max turns, fallback, wake, or concurrency internals.
- No `as any`, `@ts-ignore`, or `@ts-expect-error`.
- Record red/green/manual QA evidence under `.omo/evidence/20260806-bounded-sync-delegation/`.

---

### Task 1: Regression tests

**Files:**
- Modify: `packages/omo-opencode/src/tools/delegate-task/sync-session-poller.wall-clock.test.ts`
- Modify: `packages/omo-opencode/src/tools/delegate-task/sync-continuation.test.ts`

- [ ] Add test where first poll returns fallback-eligible error and second receives original absolute deadline, then verify wall-clock yield instead of reset.
- [ ] Add continuation test where configured deadline reaches poller, adoption returns `bg_...`, and no abort or `handedBackSyncSessions` mark occurs.
- [ ] Add Infinity tests proving no deadline is supplied/triggered and normal completion persists.
- [ ] Run targeted Bun tests before production edits. Expected: failures assert missing shared deadline and continuation adoption.

### Task 2: Shared deadline

**Files:**
- Modify: `packages/omo-opencode/src/tools/delegate-task/sync-task-runner.ts`
- Modify: `packages/omo-opencode/src/tools/delegate-task/sync-session-poller.ts`

- [ ] Compute `wallClockDeadline` once before retry loop: `Infinity` remains `Infinity`, finite setting becomes `Date.now() + timeout`.
- [ ] Pass deadline to every `pollSyncSession` call.
- [ ] Replace poller elapsed-duration check with deadline comparison while preserving fresh `inactiveStart` per poll invocation.
- [ ] Run shared-deadline test. Expected: pass.

### Task 3: Continuation ownership transfer

**Files:**
- Modify: `packages/omo-opencode/src/tools/delegate-task/sync-continuation.ts`

- [ ] Destructure wall-clock setting and compute one continuation deadline before prompt/poll.
- [ ] On `wall_clock_yield`, call `manager.adoptRunningSession()` using continuation and parent metadata; set transfer flag only after success; return background handle text.
- [ ] Add code comment explaining adopted live session must not be marked/aborted; all non-adopted exits retain `handedBackSyncSessions` plus abort cleanup.
- [ ] Run continuation tests. Expected: pass.

### Task 4: QA and completion

**Files:**
- Create: `.omo/evidence/20260806-bounded-sync-delegation/review-work-blocker-fixes.txt`

- [ ] Run specified delegate-task, background-agent, typecheck, safety grep, and `git diff --check` commands.
- [ ] Run `/tmp` manual script with four requested cases and capture output.
- [ ] Run isolated real OpenCode QA appropriate to changed `task` tool surface and record proof.
- [ ] Stage only edited source/tests/evidence, commit without amend, capture `git show --stat` and SHA in evidence.
