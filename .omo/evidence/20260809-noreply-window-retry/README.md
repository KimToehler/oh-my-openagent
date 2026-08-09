# noReply parent-wake deposits were retried as failed dispatches

Date: 2026-08-09
Branch: `fix/noreply-window-retry`
Base: `dev` @ `eff6cbd19`

## What was tested

The dispatched-parent-wake recovery window in
`packages/omo-opencode/src/features/background-agent/parent-wake-window-recovery.ts`
(`handleDispatchedParentWakeWindowElapsed`), which fires
`PARENT_WAKE_FAILURE_REQUEUE_WINDOW_MS` (5s, `manager.ts:232`) after a parent
wake is dispatched.

The behavior it was meant to prove: a `noReply` wake deposit must not be
treated as a failed dispatch when it produces no assistant output, because
producing no assistant output is exactly what a `noReply` deposit is for.

## The defect

The recovery handler used a single success signal,
`hasAssistantOrToolOutputAfterDispatchedWake`. That predicate only matches
messages with role `assistant` or `tool` (`parent-wake-session-history.ts`,
`parentWakeMessageHasOutput`). A `noReply` dispatch is deliberately admitted
with `body.noReply: true` so the parent session records the notification
WITHOUT forking an assistant turn, so the predicate can never become true for
it. Every such deposit therefore fell through to the no-output retry branch.

Two dispatch paths land here:

- a plain `shouldReply: false` wake (progress notification), and
- an admit-only deposit of a reply-required wake, dispatched with
  `forceNoReply: true`. `createTrackedDispatchedWake`
  (`parent-wake-prompt-dispatch.ts`) clones those into the dispatched tracker
  with `shouldReply: false`, so both arrive at the recovery window
  indistinguishable in reply mode.

Consequence: the wake was requeued, `noAssistantOutputRetryCount` was set to 1,
and on re-dispatch `parent-wake-prompt-dispatch.ts` supplies
`createNoAssistantOutputRetryDedupeKey(...)`, whose key includes
`retryCount`. Because the prompt gate's semantic dedupe hashes the effective
`dedupeKey` and has no independent content-hash layer
(`packages/utils/src/prompt-async-gate/semantic-dedupe.ts`), the changed key
defeats the 15s `DEFAULT_PROMPT_SEMANTIC_DEDUPE_HOLD_MS` suppression that would
otherwise have absorbed the repeat. The identical notification text is then
deposited into the parent session a second time.

This is the residual risk flagged during the 2026-08-09 live parent-wake render
investigation (`.omo/evidence/20260809-live-route-render-fix/`), now confirmed
as a real defect rather than a benign log line.

## What was observed

New failing-first test file
`packages/omo-opencode/src/features/background-agent/parent-wake-noreply-window-recovery.test.ts`,
2 cases, driving the real `ParentWakeNotifier` with `failureRequeueWindowMs: 1`:

1. a `shouldReply: false` wake is deposited, then the window elapses
2. an admit-only deposit triggered by fresh parent activity
   (`recordParentSessionActivity`), then the window elapses

Before the fix, both failed: the wake was back in the pending queue with a
scheduled retry timer.

```
Expected: false
Received: true
  at parent-wake-noreply-window-recovery.test.ts:90:63   (pending wake requeued)
  at parent-wake-noreply-window-recovery.test.ts:116:63  (admit-only requeued)
 0 pass, 2 fail
```

After the fix, both pass (`2 pass, 0 fail`).

Mutation test, to prove the tests bind to the new guard and not to incidental
state. Replacing the guard condition `if (!input.wake.shouldReply)` with
`if (false)`:

```
--- mutated: guard disabled ---   0 pass, 2 fail
--- restored ---                  2 pass, 0 fail
```

Regression surface, run in this worktree:

- `bun test packages/omo-opencode/src/features/background-agent/`
  -> **798 pass, 0 fail**, 69 files. All pre-existing parent-wake tests still
  green, including `parent-wake-window-requeue.test.ts` (the reply-required
  no-output retry, which must keep working) and
  `parent-wake-coalesce-requeue.test.ts`.
- `bun test` (full repo, run on the same tree before isolation)
  -> **12780 pass, 4 fail**. The 4 failures are the pre-existing
  `skills-loader-core` `ulw-plan` dedupe/resolve failures present on clean
  `dev`, untouched by this change.
- `bun run typecheck` -> 0 errors.

## The fix

An early return in `handleDispatchedParentWakeWindowElapsed`: when the
dispatched wake is `shouldReply: false`, clear the dispatched entry and return
without retrying. Placed after the assistant-output check, so a deposit that
DID coincide with real output still takes the existing clear path.

Liveness for a retained reply-required wake is unaffected: that wake keeps its
own pending-queue entry and its own scheduled flush
(`retainPendingWake: true` in `parent-wake-flush-runner.ts`), and its reply is
still owed via `noReplyAdmittedAt`. This handler was never what redelivered it.

## Why this is enough

The two tests cover both routes into the recovery window with a `noReply`
dispatched wake, and the mutation test proves they fail without the guard. The
798-test feature suite proves the reply-required retry path, the coalesce
requeue budget, and the admit-only deposit machinery are all unchanged.

## What was omitted

No live end-to-end TUI run. The behavior is a timer-driven internal state
transition with no user-visible surface other than the duplicate notification
text, and reproducing it live requires a 5s no-output window against a real
busy parent session. The failing-first plus mutation-tested unit coverage
pins it deterministically. No secrets, tokens, env dumps, or auth headers are
included in this record.
