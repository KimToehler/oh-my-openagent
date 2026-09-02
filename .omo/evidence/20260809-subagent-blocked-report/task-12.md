# Task 12 - Blocked-state races and park-loop bound

Worktree `.worktrees/subagent-blocked-wave2`, branch `feat/subagent-blocked-escalation`.
Commits: `e20f7c07a` (races + park bound, from the lane) and `a6dd49298` (answer-wins-expiry fix,
by the orchestrator).

Provenance, stated plainly: three successive lanes were killed by a 15-minute no-activity stale
timeout. The cause was a user-config knob, `background_task.staleTimeoutMs: 900000` in
`~/.omo/omo.jsonc`, overriding the 45-minute default. It was raised to 2700000, but a running
opencode process reads config at startup, so the leash stayed in force and the third lane died
too. The lane session record was purged with the cancellation, so continuation was impossible.
The remaining work was implemented directly by the orchestrator rather than by a fourth lane
that would likely have met the same fate.

## WHAT WAS TESTED

1. The lane's original race-(a) test, against a mutation removing the atomic
   `blockedEscalation.claim()` guard from the resume path.
2. A direct probe of the real answer-vs-expiry interleaving: resume gated in flight, expiry
   deadline crossed while the dispatch is still pending.
3. The same probe after implementing option 2 (expiry defers while a resume is in flight).
4. Mutation A: the `shouldDeferExpiry` predicate removed from the manager wiring.
5. Mutation B: `MAX_BLOCKED_PARKS` raised from 3 to 999999.
6. Scoped suite `packages/omo-opencode/src/features/background-agent/` and `bun run typecheck`.

## WHAT WAS OBSERVED

1. The lane's test was VACUOUS: 4 pass / 0 fail both with and without the guard. The lane
   reported BLOCKED rather than claiming a pass it had not earned, which was correct. Root
   cause: the test let the resume run to completion before firing the timer, so
   `expireBlockedTask` hit its `if (!isTaskBlocked(task)) return` early exit and the two sides
   never contended.
2. The probe showed the spec was NOT implemented at all. Mid-flight the task is
   `status="running"` with `blockedAt` still set; expiry then claimed it and the accepted
   answer was silently swallowed. Final state was `cancelled` /
   `Blocked task expired unanswered`. The plan requires the answer to win once the resume is
   accepted, so this was a production defect, not a test defect. That is what the lane's second
   BLOCKED report said, and it was right.
3. After option 2: mid-flight `inflight: 1`, expiry deferred, final `status="running"`,
   `blockedAt` cleared, no error, and the in-flight set back to 0 (no leak). With no resume at
   all, expiry still wins: `cancelled` / `Blocked task expired unanswered`.
4. Mutation A killed: 1 pass -> 0 pass / 1 fail.
5. Mutation B killed: 4 pass -> 3 pass / 1 fail.
6. Scoped suite 839 pass / 0 fail across 76 files. Typecheck exit 0 with 0 errors, exit code
   captured on its own line rather than through a pipe.

## REGRESSION FOUND AND FIXED DURING THIS WORK

The first version of the fix gated the blocked-state clearing on the claim result:
`if (wasBlocked && this.blockedEscalation.claim(id))`. That broke the pre-existing test
`blocked-resume.test.ts` "dispatch accepts the parent answer". Root cause: a blocked task
resumed WITHOUT armed escalation timers returns `claim() === false`, so `blockedAt` was never
cleared and the task would stay permanently blocked. The claim result must gate only the
escalation timers, never the blocked-state clearing. Fixed by separating the two statements;
the scoped suite went from 838 pass / 1 fail back to 839 pass / 0 fail. This is exactly the
class of bug the differential run exists to catch.

## WHY IT IS ENOUGH

Both surviving-mutation gates now fail when their guard is broken and pass when it is intact,
verified by the orchestrator rather than taken from a lane self-report. The answer-wins path and
the nobody-answers path were both exercised against real timers, so the deferral is proven not
to be a permanent leak in the one direction that matters most: a deferred expiry that never
fires would strand a task forever.

## VACUOUS TEST REPLACED (commit `02a4f30d3`)

The lane's original race-(a) test was removed and replaced with the real-timer interleaving from
the probe: the resume is gated in flight, the expiry deadline (60ms via injected config) passes
during that window, and the test asserts the answer wins with the in-flight set back to 0. A
companion case asserts that a block nobody answers still expires, so the deferral cannot become a
permanent leak. The decorative `mergeParentWakeNotifications` assertion that compared empty
strings was dropped.

Proof the COMMITTED test is load-bearing, not just green: removing the `shouldDeferExpiry`
predicate takes `blocked-races.test.ts` from 5 pass / 0 fail to 4 pass / 1 fail. Its predecessor
passed 4/4 with or without the guard, which is precisely why it was worthless.

Final gates: 840 pass / 0 fail across 76 files. Typecheck exit 0 with 0 errors.

One typecheck run in the middle of this work reported exit 2 with a single
`packages/tmux-core/src/runner.ts ... Cannot find module '@oh-my-opencode/utils/runtime'` error.
A stash-and-recheck initially suggested it was mine, but two further runs on identical source
returned exit 0 / 0 errors. It was a transient stale-build-artifact race from the earlier
`bun install`, not a defect in this change. Recorded rather than quietly discarded, because the
convenient reading of a flake is usually the wrong one.

## WHAT WAS OMITTED

The skipped/failed-resume branch of the deferral is still NOT independently proven. The probe
written for it never drove the prompt gate into its skipped path - the task ended `running`
rather than expired - so the `restoreTaskAfterSkippedResume` interaction with the in-flight
marker rests on code reading plus the `finally` covering all exit paths, not on a live
observation. Recorded as an open gap.

No live-harness run. The `opencode-qa` SEAM verification remains deferred to the F1-F5 final
wave, where a real parent session must be observed receiving the BLOCKED wake, the 10-minute
reminder, and the answer-accepted resume. Everything above is unit-level. No secret-bearing
output was produced.
