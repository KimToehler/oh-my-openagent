# Task 10 - Bounded escalation for unanswered blocked tasks

Worktree: `.worktrees/subagent-blocked-wave2`, branch `feat/subagent-blocked-escalation`, base `dev@7a663725c`.

Note on provenance: the implementing lane (`bg_c21b05e1`) was cancelled by the 15-minute
stale-task timeout with its work uncommitted but complete on disk. No replacement lane was
spawned. Every verification recorded below was executed by the orchestrator directly against
the on-disk tree, including both mandatory self-mutations, which is the same standard a lane
DoneClaim would have had to meet.

## WHAT WAS TESTED

1. `bun test packages/omo-opencode/src/features/background-agent/blocked-escalation.test.ts`
   - the six acceptance behaviors: exactly one re-wake at 10 min, hard expiry at 20 min,
     both timers cancelled on an accepted resume, timers NOT cancelled on a queued or skipped
     resume, the reminder surviving wake dedupe in both merge orderings, and no reminder
     firing after expiry has already run.
2. Mutation 1 - `buildBlockedReminderNotification` reduced to `return notification`, so the
   reminder text becomes byte-identical to the first BLOCKED wake.
3. Mutation 2 - the manager's `onExpiry` handler replaced with a no-op `() => {}`.
4. Differential scoped suite, `packages/omo-opencode/src/features/background-agent/`, run on
   `dev` and on the worktree.
5. `bun run typecheck`, real exit code captured, not a piped one.

## WHAT WAS OBSERVED

1. 6 pass / 0 fail, 18 expect() calls.
2. Mutation 1 killed: 5 pass / 1 fail. The dedupe test failed on
   `expect(reminder).not.toBe(first)`. This is the load-bearing assertion, because wave 1
   shipped exactly this class of bug - a BLOCKED wake that dedupe silently discarded.
3. Mutation 2 killed: 4 pass / 2 fail, the expiry and the queued/skipped-resume tests.
4. Both mutations reverted, verified by re-grepping for `expireBlockedTask` and the
   `reminder 1 of 1` marker before proceeding.
5. Differential: `dev` 829 pass / 0 fail across 74 files, worktree 835 pass / 0 fail across
   75 files. Exactly +1 file and +6 tests, which is this task's own suite, and no regression
   in any pre-existing test.
6. Typecheck: initially exit 2 with 34 errors. Root cause was the worktree having no
   `node_modules` - `bun test` resolves upward into the parent checkout, `tsgo` does not, so
   every error was an unresolved `@code-yeongyu/senpi` or
   `@oh-my-opencode/omo-opencode/config-migration` module and none were in `background-agent`.
   After `bun install` in the worktree: exit 0, 0 errors. Recorded because the first
   `TYPECHECK_EXIT=0` reading was invalid - it was `tail`'s exit status through a pipe, not
   the typecheck's.

## WHY IT IS ENOUGH

The two mutations target the exact failure modes this task can plausibly ship: a reminder that
dedupe eats, and an expiry timer that never fires. Both were proven to fail the suite when
broken and pass when correct, verified independently rather than taken from a lane's self-report.
The differential run proves the 44 added lines in `manager.ts` disturbed nothing in the 829
tests that already guarded this feature, which matters because `manager.ts` is where wave 1's
four review blockers all landed.

## WHAT WAS OMITTED

No live OpenCode harness run. The escalation path is timer-driven and covered here with fake
timers only; real-harness proof of a parent actually receiving the 10-minute reminder is
deferred to the F1-F5 final wave's mandatory `opencode-qa` run, which is where the plan already
places the SEAM-level verification. Treat this task as unit-proven and integration-pending.
No secret-bearing output was produced; nothing needed redaction.
