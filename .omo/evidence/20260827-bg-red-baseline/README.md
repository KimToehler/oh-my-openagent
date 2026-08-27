# PR 0 background-agent red baseline QA

## WHAT WAS TESTED

- `bun test packages/omo-opencode/src/features/background-agent/manager.polling.test.ts` before edit: reproduced three failing todo-gate cases against real wall clock.
- Pinned four tests through `withFixedNow(fixedNow, fn)`, which restores `Date.now` in `finally`; reran manager selector.
- `bun test packages/omo-opencode/src/features/background-agent/parent-wake-pending-queue.test.ts` after asserting only live observable behavior.
- Mutated `MAX_COALESCE_REQUEUE_ATTEMPTS` from `3` to `0`, ran pending-queue selector, then restored production file byte-for-byte from `/tmp/parent-wake-prompt-dispatch.ts.pr0`.

## WHAT WAS OBSERVED

- Before manager selector: `21 pass`, `3 fail`; each failed because fixture date `2026-08-17` was compared with unmocked wall clock.
- After manager selector: `24 pass`, `0 fail`.
- Pending-queue selector after replacement assertion: `5 pass`, `0 fail`.
- Mutation selector failed: second real dispatch assertion received one call rather than two. Full transcript is preserved in parent task output; mutation also invalidated delay-derived queue tests because division by zero makes delay `Infinity`.

## WHY IT IS ENOUGH

- `session remains active`: pin keeps fixture inside intended grace state, so busy-session todo-gate behavior remains `running` rather than accidental wall-clock expiry cancellation.
- `valid output is absent`: pin keeps todo-gate grace open, so absent valid output remains `running` with no unfinished count rather than accidental expiry error.
- `first observation is inside grace window`: pin makes first observation deterministic, so test verifies stamp-and-wait behavior rather than historical fixture expiry.
- `both grace conditions expire`: shared helper preserves existing expiry assertion and validates same fixed-time mechanism for every test in block.
- Failure 4 decision: success path intentionally deletes `coalesceRequeueCount` in `parent-wake-prompt-dispatch.ts` after accepted dispatch, and queue merge also resets it when notifications change. It is retry-internal transient state, not an observable delivery contract. Test now asserts claimed behavior, two real `promptAsync` calls before cap; cap mutation fails this assertion, proving it bites. No production file changed.

## WHAT WAS OMITTED

- No OpenCode live-harness QA: test-only change, no OpenCode-connected production surface changed.
- Raw environment dumps and credential-bearing logs omitted.

- Full scoped suite after repair: `909 pass`, `0 fail`, `2393 expect() calls`, `Ran 909 tests across 80 files. [31.21s]`.
- Mandatory stash proof restored old manager test file and reproduced `21 pass`, `3 fail`, `51 expect() calls`, `Ran 24 tests across 1 file. [75.00ms]`; `git stash pop` restored repair. New manager selector then reported `24 pass`, `0 fail`, `53 expect() calls`, `Ran 24 tests across 1 file. [75.00ms]`.
- `bun run typecheck` exited `2` before checking this package because workspace dependencies are absent: `packages/omo-senpi/src/components/memory/tools.ts` cannot resolve `typebox`, and memory worker files cannot resolve `@earendil-works/pi-tui`.
- LSP diagnostics could not initialize because TypeScript installation is unavailable: `Could not find a valid TypeScript installation.`
