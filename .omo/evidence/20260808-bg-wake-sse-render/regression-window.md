# Regression-window archaeology: parent-wake retry/dedupe collision

## Bug recap (given)

- Ingredient A (semantic dedupe + "queued" treated as accepted): v4.6.0, `086fd3fd4`, 2026-06-01.
- Ingredient B (no-assistant-output retry): v4.9.0, `f174c0cf2` + `5bd586448`, 2026-06-22.
- Both predate the window in which the symptom became noticeable. The actual
  retry-vs-15s-hold collision logic (`packages/utils/src/prompt-async-gate/`,
  `parent-wake-notifier.ts`, `parent-wake-history-state.ts`) is **unchanged**
  in the last 6 weeks (only touched by an unrelated merge, `46a55adb1`,
  "codex-v2-catalog-guards-qa"). So no later commit rewired the collision
  mechanism itself — the question is what raised its *frequency*.

## Candidates taken seriously, with stated mechanism

### 1. `a456466d1` — fix(background-agent): stop stranded concurrency slots starving queued tasks (2026-07-26)

**Mechanism:** Before this fix, a background task whose concurrency slot was
acquired but not yet recorded on `task.concurrencyKey` (a ~150-line/3-await
gap in `startTask`) would leak its slot forever if cancelled/errored in that
window; the task never reached `startTask`, so it never got a session and
never completed — meaning it **never dispatched a parent-wake prompt at all**.
After the fix, those tasks now run to completion (or fail visibly within a
bounded `acquireTimeoutMs`) instead of silently wedging. Net effect: strictly
more background-task completions per unit time → strictly more
`sendParentWakePrompt` calls → more chances to land inside the pre-existing
no-output-retry / 15s-semantic-dedupe-hold collision window. This is a
**volume** multiplier, not a change to the collision logic itself.

### 2. `308e84418` — feat(background-agent): adopt a running session as a background task (2026-08-06)

**Mechanism:** Adds a new way for an already-running opencode session to be
registered as a tracked background task retroactively. Sessions reached this
way previously produced **no parent-wake notification at all** (they weren't
background tasks); after this commit they are, and their completion now goes
through the same `parent-wake-flush-runner` → `sendParentWakePrompt` path as
every other background task. This is a **new wake source**: it adds dispatch
attempts to the system that did not exist before, each one an independent
chance to hit the collision.

### 3. `a47f804c9` + `e65752afc` + `c0af74ee1` — the 300s retained-admit-ceiling chain (2026-08-07 / 2026-08-08)

Three commits building one mechanism:
- `a47f804c9` introduces `PENDING_PARENT_WAKE_MAX_RETAINED_ADMIT_DEFER_MS`
  (300s): a wake parked behind a persistently-active/unsafe parent, which
  previously deferred **forever with zero dispatch**, now falls through to a
  forced `noReply` deposit dispatch once 300s elapse.
- `e65752afc` fixes a marker-aliasing correctness bug in that same mechanism
  (splits `noReplyAdmittedAt` vs `lastAdmitOnlyDepositAt`) without changing
  the 300s cadence or which paths dispatch.
- `c0af74ee1` extends the *same* ceiling to paths that `a47f804c9` left
  unbounded: the failure-wake branch and every defer site that routes through
  `deferReplyWakeWhileUnsafe` (tool-wait deferral, user-message-in-progress,
  final-confirm, fresh-activity-for-failure-wakes).

**Mechanism:** Each of these previously-unbounded defer paths now performs an
actual `sendParentWakePrompt` dispatch (via `dispatchInternalPrompt`) every
300s instead of parking indefinitely with no dispatch. That is strictly more
dispatch attempts, on strictly more code paths, than existed before
2026-08-07. More dispatch attempts through the shared `sendParentWakePrompt`
path is more opportunities for whatever triggers the no-output retry to fire
on one of them.

**Caveat (explicitly labeled speculation):** These specific periodic
re-admissions pass `emptyAssistantTurnRetry: false` and `forceNoReply: true`
in the call to `sendParentWakePrompt` (see `parent-wake-flush-runner.ts`
around the `shouldAdmitRetainedWakeAfterCeiling` call site), so on their own
they do not obviously set `input.latestWake.allowEmptyAssistantTurnRetry` or
build the `emptyAssistantTurnRetry` dedupe key that Ingredient B's retry path
depends on (`createEmptyAssistantTurnRetryDedupeKey`). Whether a `noReply`
dispatch can still trigger `isEmptyNoProgressAssistantTurnInfo` in
`manager.ts:handleEvent` (which would re-arm the retry via
`requeueDispatchedParentWakeAfterEmptyAssistantTurn`) depends on whether
opencode core still emits an assistant "empty turn" event for a `noReply`
prompt. I did not verify opencode's server-side handling of the `noReply`
body flag, so I cannot confirm this chain multiplies the *specific* retry
path rather than just adding a parallel category of dispatch. Treat the
"more dispatch attempts on more paths" part as verified; treat "these
dispatches specifically feed the empty-turn retry" as unverified.

## Weaker / rejected candidates

- `e65752afc`, `1f0783ded`, `1ffe05a1d`, `8e7cc1fda` (tests/marker-alias fix
  around the same chain) — folded into candidate 3 above; no independent
  mechanism.
- `0b4ef28fc` (owe retention on dispatched/in-flight wakes) and `82b32ac08`
  (keep completed tasks retrievable until wake consumed) — both fix task
  *removal timing* relative to an owed wake, not wake dispatch frequency.
  They affect whether a task is prematurely reaped, not how often
  `sendParentWakePrompt` fires. Ruled out: no frequency mechanism.
- `b505e8363` (bound the activity-lookup stale deferral) — bounds a different
  stale-check path in `task-poller.ts`; touches wake *scheduling* latency, not
  the collision-prone retry/dedupe pairing. Ruled out: topical but no stated
  mechanism found connecting it to the 15s hold.
- `b3b45cd2a` (migrate Mini chains to Luna/DeepSeek, 2026-07-31) — plausible
  *if* background-agent tasks route through the migrated model chains and the
  new models produce more empty/no-output assistant turns than before, which
  would directly increase Ingredient B's trigger rate rather than just
  dispatch volume. I did not verify whether background-agent's default model
  selection uses the migrated "Mini" chain, so this is **speculation only**,
  not a confirmed finding.
- `2e8968901` (make mid-batch notification session handle machine-parsable),
  `8f57a4661` (carry child session id into completion notifications),
  `8f57a4661`'s neighbors, `56255ff51`, `877d1eff9`, `d6bbba552`,
  `56c57a4f2`, `ad0085b2b` — topically in the directory but no stated
  mechanism connects them to dispatch frequency or hold-window overlap;
  ruled out.

## Conclusion

No single commit is a clean, fully-verified frequency multiplier. Best
supported reading: **`a456466d1` (2026-07-26) and `308e84418` (2026-08-06)**
are each independently verified to add previously-nonexistent parent-wake
dispatch volume (stranded-task unwedging and a brand-new adoption wake
source, respectively), and the **`a47f804c9`/`e65752afc`/`c0af74ee1` chain**
(2026-08-07/08) is verified to add dispatch attempts on paths that previously
never dispatched at all, though its link to the *specific* empty-turn retry
path is unverified. All three raise the number of `sendParentWakePrompt`
calls happening in the system without changing Ingredients A or B
themselves, which is consistent with "more chances to hit a pre-existing
collision" rather than "a new bug." I did not find a commit that shortens the
15s hold, lengthens no-output-retry frequency directly and verifiably, or
otherwise changes the collision mechanics themselves.

## Method

All commands run read-only from `/Users/tim/git/oh-my-openagent` (main
checkout, branch `dev` at `c0af74ee1`). No files other than this one were
written; no branches created/switched; nothing staged or committed.

```
git log --oneline --since="6 weeks ago" -- packages/omo-opencode/src/features/background-agent/ packages/utils/src/prompt-async-gate/

git show -s --format="%H %ad %s" --date=short <sha>   # per candidate

git show --stat --format="" <sha>                      # per candidate, file scope

git show <sha> -- <specific-path>                       # full diff, scoped to
                                                          # relevant file(s) only,
                                                          # redirected to /tmp/*.diff
                                                          # and read from there

git log --oneline --since="6 weeks ago" -- packages/omo-opencode/src/features/background-agent/parent-wake-notifier.ts packages/omo-opencode/src/features/background-agent/parent-wake-window-recovery.ts packages/omo-opencode/src/features/background-agent/parent-wake-history-state.ts

grep -rn "allowEmptyAssistantTurnRetry" packages/omo-opencode/src/features/background-agent/parent-wake-notifier.ts packages/omo-opencode/src/features/background-agent/parent-wake-window-recovery.ts

grep -rn "requeueDispatchedParentWakeAfterEmptyAssistantTurn" packages/omo-opencode/src/

git show --stat --format="%H %ad %s" --date=short b3b45cd2a
git show --stat --format="%H %ad %s" --date=short 308e84418
git show --stat --format="%H %ad %s" --date=short 8f57a4661
```
