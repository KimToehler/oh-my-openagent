# Handoff prompt — mid-batch background-task wakes starve a busy orchestrator

Paste everything below the line into a fresh session **in `/Users/tim/git/oh-my-openagent`**.

## Status update (Wave 5, `bg-wake-and-crossprocess-lookup` plan)

This file was relocated here from the repo root (`HANDOFF-PROMPT-mid-batch-wake-starvation.md`,
untracked) because `.omo/plans/` is the planning-artifact directory, and this is a planning
prompt, not runtime state (`.omo/tasks/`) or captured output (`.omo/evidence/`).

Two corrections to the analysis below, both drawn from
`.omo/evidence/20260807-bg-wake-crossproc/WAVE1-FINDINGS.md`:

- **The "instance mismatch" hypothesis is CONFIRMED, with a corrected mechanism.** The
  "Candidate directions" section below treats `formatTaskNotFoundMessage`'s cross-instance
  framing as misleading and something that "sent the previous investigation down a wrong
  path." That verdict itself needed correcting. A committed test
  (`create-background-output.cross-instance.test.ts`, Test 1, green) proves two
  `BackgroundManager` instances inside ONE realm still share the `globalThis` registry, so a
  same-realm two-manager split cannot produce the symptom. The real mechanism is a
  **process/realm boundary**: `background_output` executes in a different OS process than
  the one whose in-memory `BackgroundManager` owns the task. Cross-instance was the right
  family of explanation; same-realm was the wrong scope.
- **The retention-race framing is FALSIFIED.** The "What is ALREADY FIXED" section below
  says D1 *and* D3 "have since been fixed on `dev`" via the retention guard. Only D1 is
  actually a retention fix. D3, framed as a notification/retention contract violation, is
  falsified by the n=6 production log ledger:
  - `bg_a4f323d2` completed 14:47:01, missing 14:47:09 (**8.8 seconds** later, against a
    10-minute `TASK_CLEANUP_DELAY_MS`), with **no removal line ever logged**.
  - All 6 observed ids: `Removed completed task from memory` lands **6 to 8 minutes AFTER**
    the failed lookup, never before it.
  - `bg_f3c12652` specifically: missing 14:24:17, removed **14:32:28** (8m11s later).

  No retention timer, however tuned, produces an 8.8-second miss with zero removal log. The
  retention guard fix genuinely closes D1 (early reaping while a wake is still owed) but
  does not, and structurally cannot, close the process-boundary lookup failure. That failure
  is closed instead by the `create-background-output.ts` transcript-scan fallback (see
  `packages/omo-opencode/src/tools/background-task/AGENTS.md`), not by anything retention-shaped.

D2, the subject of this handoff, is real as characterized below and has since been fixed by
a 300-second bounded re-admission ceiling that deposits `noReply` only, never a forced reply
(Wave 2 of the plan above). `parent-wake-active-defer-ceiling.test.ts:145` was left
deliberately unchanged, per the constraint this document itself sets out below.

---

## The report (live, reproduced repeatedly over two days)

An orchestrator session in a *different* repo (`/Users/tim/git/onara`) fires 3–8
`task(..., run_in_background=true)` agents, then keeps working while they run. Over
a two-day span, across many batches, the observed behaviour was:

- **Mid-batch completions almost never woke the parent.** The orchestrator ended
  turn after turn saying "I'll report when they land"; the trigger did not arrive
  and the work stalled until the human intervened.
- **When notifications did arrive, they were usually the final
  `[ALL BACKGROUND TASKS COMPLETE]`** — sometimes fired twice for the same batch.
- **`background_output(task_id="bg_...")` frequently returned `Task not found`**
  even when called as the very first action after a notification. Recovery only
  ever worked via `Session_read` / `task(task_id="ses_...")` — the subagent
  *sessions* survive, the `bg_*` registry entries do not.

The user's words: *"since 2 days you always say that you will report as soon as the
background jobs return, but you never get any kind of trigger or continue on your
own. The work just dies."*

## What is ALREADY FIXED — do not redo this

`HANDOVER-background-task-notification-bug.md` (repo root) documents D1/D2/D3. **D1
and D3 have since been fixed on `dev`; that handover is stale on those two points.**
Verified in source at `88042784f`:

- `manager.ts:2405-2440` — `scheduleTaskRemoval` now defers cleanup while a wake is
  still owed, checking three states independently (`pendingParentWake.shouldReply`,
  `dispatchedParentWake.shouldReply`, `hasInFlightParentWakeDispatch`), capped by
  `TASK_TTL_MS`. The comment cites the handover's D1/D3 explicitly.
- `task-completion-retention-guard.test.ts` — 4 tests covering exactly this.
- `parent-wake-active-defer-ceiling.test.ts` — 6 tests covering the ceiling.

> **Correction (Wave 5):** "D1 and D3 have since been fixed" overstates it. D1 is a
> genuine fix. D3 was never a retention bug to begin with, so the retention guard
> does not fix it; D3's actual symptom is closed separately by the process-boundary
> transcript-scan fallback. See the status update at the top of this file.

Read both test files before touching anything.

## What is STILL OPEN — this is the job

**D2: mid-batch (`shouldReply === false`) wakes have no defer ceiling, and the
retention guard does not protect them either.**

Two lines carry the whole defect:

```ts
// manager.ts:2781
const shouldReply = allComplete || isTaskFailure

// parent-wake-flush-runner.ts:256-258
private shouldForceDispatchAfterActiveDefer(wake: PendingParentWake): boolean {
  return wake.shouldReply && this.getQueuedAgeMs(wake) >= PENDING_PARENT_WAKE_MAX_ACTIVE_DEFER_MS
}
```

A mid-batch success has `shouldReply === false`. So:

1. **No forcing function.** `PENDING_PARENT_WAKE_MAX_ACTIVE_DEFER_MS` (60s,
   `parent-wake-flush-runner.ts:18`) only forces `shouldReply` wakes. A parent that
   never idles defers a `noReply` wake indefinitely.
2. **No retention protection.** The `wakeStillOwed` guard at `manager.ts:2430-2434`
   tests `shouldReply === true` on both pending and dispatched wakes. A mid-batch
   wake therefore does **not** pin its task, so the 10-minute
   `TASK_CLEANUP_DELAY_MS` reaps it while its notification is still queued —
   producing `Task not found` for a task the orchestrator was told to fetch.

The existing test `parent-wake-active-defer-ceiling.test.ts:145` (*"retained noReply
wake ages while parent is busy #then it does not force a reply"*) **asserts the
current behaviour as correct**. That test encodes the deliberate decision not to
interrupt a busy parent with a `noReply` wake. So this is not a simple bug — it is a
design tension:

- interrupting a working orchestrator mid-turn for every sibling completion is noisy
  and was intentionally avoided;
- but never delivering, *and* letting the result expire, is worse — it silently
  kills the work.

**Resolve that tension. Do not just flip the boolean** — that test exists for a
reason and you would be reverting a considered decision without understanding it.

## Candidate directions (pick with evidence, not by taste)

- **Fold mid-batch wakes into the final one.** Stop queuing per-task wakes; let the
  `allComplete` wake carry the full batch summary. Cheapest, and matches how the
  orchestrator actually consumes results. Check whether
  `parent-wake-final-notification-merge.test.ts` already does part of this.
- **Extend the retention guard to any owed wake**, `shouldReply` or not, so a
  deferred mid-batch wake at least cannot expire its own task. This fixes
  `Task not found` without changing delivery policy — arguably the minimum correct
  fix, and independently valuable.
- **Give `noReply` wakes their own, longer ceiling** so they eventually land as
  `noReply` admissions rather than never.
- **Make the batch summary self-healing**: if a task named in a notification is
  already gone, have `background_output` fall back to the subagent session
  transcript (which demonstrably survives) instead of returning `Task not found`.
  `formatTaskNotFoundMessage` (`create-background-output.ts:81-105`) currently
  blames cross-instance state, which is misleading — it sent the previous
  investigation down a wrong path.

> **Correction (Wave 5):** the last bullet's verdict on `formatTaskNotFoundMessage`
> is reversed. It was not misleading; it named the right family of cause and was
> dismissed for it, which is what actually cost the two days. The mechanism needed
> one correction (process/realm boundary, not same-realm two-manager split, see
> the status update at the top of this file), not a rejection. This direction is
> also the one that shipped: on a `getTask` miss, `background_output` now scans the
> calling session's transcript for the `bg_ -> ses_` pairing and recovers the child
> result directly.

## Required approach

1. **Reproduce first, with a failing test.** No fix before red. The rig you need
   already exists — `task-completion-retention-guard.test.ts` has the `FakeTimers`
   harness (`getDelay`/`advanceBy`/`runNext`) and `PromptAsyncCall` capture;
   `parent-wake-active-defer-ceiling.test.ts` has the `createNotifier` +
   `sessionStatuses` + `Date.now` override pattern. Reuse them.
2. **The contract test that matters most:** launch N tasks, complete them one at a
   time with the parent continuously busy, and assert that (a) every completion is
   eventually delivered, and (b) every `bg_*` id named in any delivered notification
   is still retrievable via `manager.getTask(id)` when it lands. That is the
   user-visible promise, and it is currently broken.
3. **Do NOT raise `TASK_CLEANUP_DELAY_MS`** (`constants.ts:22`). It converts a loud
   failure into a rare one and leaves the ordering bug intact. The prior handover
   says this too.
4. **Worktree discipline** (`.omo/rules/worktrees.md`): work in
   `.worktrees/<slug>`, never on `dev` directly. Note `git status` currently shows 4
   unrelated modified files in `packages/omo-codex` / `packages/omo-senpi` — leave
   them alone, do not stage them.
5. `manager.ts` is **3335 lines** — windowed reads (`offset`/`limit`) or `rg` only;
   an unbounded read blows the tool ceiling.
6. Tests are `bun:test`; run the focused file, not the suite. Registry state lives on
   `globalThis` — use `clearBackgroundTaskRegistryForTesting()`
   (`task-registry.ts:141-144`) in `afterEach` or tests leak into each other.

## Key files

| File | Why |
|---|---|
| `packages/omo-opencode/src/features/background-agent/manager.ts` | `shouldReply` `:2781`; retention guard `:2405-2440`; `notifyParentSession` `:2703-2823`; `scheduleTaskRemoval` |
| `.../parent-wake-flush-runner.ts` | 8 early-return defer/drop paths; ceiling `:18`, `:256-258` |
| `.../parent-wake-notifier.ts` | queue/dispatch/tracking surface used by the guard |
| `.../task-completion-retention-guard.test.ts` | D1/D3 coverage — the shape to extend |
| `.../parent-wake-active-defer-ceiling.test.ts` | encodes the current `noReply` decision — read `:145` before changing policy |
| `.../parent-wake-final-notification-merge.test.ts` | check before building fold-into-final |
| `.../constants.ts` | `TASK_CLEANUP_DELAY_MS:22`, `TASK_TTL_MS:4` |
| `src/tools/background-task/create-background-output.ts` | `Task not found` text `:81-105`; `recordBackgroundOutputConsumption` `:14` |
| `HANDOVER-background-task-notification-bug.md` | prior diagnosis — **stale on D1/D3, still correct on D2** (see the status update on that file for the corrected D3 verdict) |

## Definition of done

- A test that fails on `dev` today and passes after the fix, asserting mid-batch
  completions reach a continuously-busy parent **and** remain retrievable.
- `parent-wake-active-defer-ceiling.test.ts` either still passes, or is deliberately
  and explicitly updated with the reasoning recorded in the commit message.
- No change to `TASK_CLEANUP_DELAY_MS`.
- The stale D1/D3 sections of `HANDOVER-background-task-notification-bug.md` marked
  fixed, so the next reader is not misled the way this investigation was.
