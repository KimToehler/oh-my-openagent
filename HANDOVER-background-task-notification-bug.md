# Handover — background-task completion notifications: two live defects

**Repo**: `/Users/tim/git/oh-my-openagent`
**Package**: `packages/omo-opencode`
**Area**: `src/features/background-agent/` + `src/tools/background-task/`
**Status**: investigated, root-caused, **nothing changed** — no commits, no edits, clean tree.

This is a read-only diagnosis handover. Everything below was observed live in a
real Sisyphus session, then traced to specific lines. Reproduce before fixing.

---

## What was observed (two separate symptoms, one session)

The reporting session was an orchestrator in a *different* repo (`/Users/tim/git/onara`)
that fired 4 parallel `task(..., run_in_background=true)` explore agents, twice.

### Batch 1 — notifications never arrived

4 agents launched, all 4 completed. The parent session received **zero**
`<system-reminder>` messages. The orchestrator only discovered completion by
guessing and calling `background_output` manually — which then returned:

```
Task not found: bg_0e159856
Task not found: bg_201edaf9
Task not found: bg_5b54acde
Task not found: bg_5cf99cc9
```

All four results were unrecoverable through the tool. They were recovered only by
`task(task_id="ses_...")` continuation, asking each subagent to restate its answer
verbatim — the subagent *sessions* were still alive and intact.

### Batch 2 — notifications arrived, results still gone

Same orchestrator, 4 more agents. This time all 4 `[BACKGROUND TASK RESULT READY]`
reminders **did** arrive, followed by `[ALL BACKGROUND TASKS COMPLETE]`. The
orchestrator immediately called `background_output` on all four IDs in a single
parallel block — the first action after the notification, no intervening work:

```
Task not found: bg_244a1668
Task not found: bg_a11565f2
Task not found: bg_eaec1323
Task not found: bg_6883d302
```

Then a *second* `[ALL BACKGROUND TASKS COMPLETE]` reminder fired for the same four
task IDs, after they had already been reported missing.

**This is the sharper defect.** The system told the orchestrator "your next action
should be to call `background_output(task_id=...)`", the orchestrator did exactly
that with zero delay, and the store had already dropped the tasks. The notification
and the retention policy disagree about what is retrievable.

Note the asymmetry: subagent *sessions* survived both batches (continuation worked
every time). Only the `bg_*` task registry entries vanished.

---

## Map of the machinery

### Storage — three tiers, all in-process

`getTask` is the single read path (`manager.ts:1067-1069`):

```ts
getTask(id: string): BackgroundTask | undefined {
  return this.tasks.get(id) ?? this.completedTaskArchive.get(id) ?? getRegisteredBackgroundTask(id)
}
```

| Tier | Where | Bound | Notes |
|---|---|---|---|
| `this.tasks` | `manager.ts` instance | unbounded | live tasks; deleted by `removeTask` |
| `this.completedTaskArchive` | `manager.ts:268` | `MAX_COMPLETED_TASK_ARCHIVE_SIZE`, FIFO (`:466-474`) | **requires `task.sessionId`** (`:442-444`) |
| global registry | `task-registry.ts`, `globalThis.__omoBackgroundTaskRegistry` | 100, FIFO (`trimCompletedTasks`, `:86-94`) | survives manager instances, not processes |

All three are per-process. `formatTaskNotFoundMessage`
(`create-background-output.ts:81-98`) already documents the multi-instance case —
but that is **not** what happened here: one opencode instance, one orchestrator.

### Removal — the 10-minute timer

`scheduleTaskRemoval` (`manager.ts:2348-2385`), delay
`config.taskCleanupDelayMs ?? TASK_CLEANUP_DELAY_MS` where
`TASK_CLEANUP_DELAY_MS = 10 * 60 * 1000` (`constants.ts:22`). On fire it calls
`clearNotificationsForTask` → `removeTask` → `archiveBackgroundTask` + `tasks.delete`.

It has a sibling-aware reschedule (`:2360-2371`): while any sibling is still
`running`/`pending` it defers, up to `MAX_TASK_REMOVAL_RESCHEDULES = 6`
(`manager.ts:229`) or `TASK_TTL_MS = 30 min` (`constants.ts:4`), whichever first.

`scheduleTaskRemoval` is called from **7 sites**: `:538`, `:2032`, `:2148`, `:2466`,
`:2746`, `:2992`, and via `removeTask` at `:2374`.

The one that matters: **`notifyParentSession` schedules removal itself**
(`manager.ts:2745-2747`), in the same call that queues the wake:

```ts
if (task.status !== "running" && task.status !== "pending") {
  this.scheduleTaskRemoval(task.id)
}
```

The timer starts when the notification is **queued**, not when it is delivered, and
not when the parent reads the result. Nothing in the removal path checks whether the
wake was ever dispatched, or whether `background_output` has consumed the task.
`recordBackgroundOutputConsumption` (`create-background-output.ts:14`, called at the
`completed` branch) exists but does not feed the retention decision.

### Delivery — queue, flush, dispatch

`notifyParentSession` (`manager.ts:2627-2748`) builds the text via
`buildBackgroundTaskNotificationText` and queues a wake. Both branches of the
`shouldDeferNotification` conditional (`:2709` and `:2723`) call
`queuePendingParentWake` with **identical arguments** — the if/else is dead
structure; only the log line differs.

`ParentWakeFlushRunner.flushPendingParentWake`
(`parent-wake-flush-runner.ts:23-154`) then decides. It has **eight** early-return
paths before the plain dispatch at `:143`:

| Line | Condition | Effect |
|---|---|---|
| `:24` | no wake queued | return |
| `:34-40` | session became active after idle settle | reschedule |
| `:47` | `dropAdmittedWakeConsumedByParent` | **delete wake, never send** |
| `:52-58` | session active, under defer ceiling | reschedule |
| `:60-77` | recent parent activity | admit-only `forceNoReply: true` |
| `:80-91` | tool-wait defer | admit-only `forceNoReply: true` |
| `:93-113` | user message in progress | admit-only `forceNoReply: true` |
| `:120-134` | history became unsafe | admit-only `forceNoReply: true` |
| `:137-141` | redundant vs dispatched | **delete wake, suppress** |

`PENDING_PARENT_WAKE_MAX_ACTIVE_DEFER_MS = 60_000` (`:18`) caps the active-defer
loop, but only for `shouldReply` wakes (`shouldForceDispatchAfterActiveDefer`, `:256-258`).

`shouldReply` is `allComplete || isTaskFailure` (`manager.ts:2705`). **A mid-batch
success wake has `shouldReply === false`** and therefore no defer ceiling — it can
be deferred indefinitely while the parent stays busy. That is a strong candidate for
batch 1: an orchestrator that keeps working never goes idle, so per-task wakes
reschedule forever and only the final `allComplete` wake has a forcing function.

`sendParentWakePrompt` (`parent-wake-prompt-dispatch.ts:31-112`) does the actual
`dispatchInternalPrompt({ mode: "async", ... })`. Failures requeue and reschedule
(`:106-111`); gate rejections requeue (`:93-101`). Nothing here touches the removal
timer either.

---

## Root cause

**Retention is scheduled on notification-queue, but retrieval is only possible after
notification-delivery — and the two are decoupled, unbounded, and can be reordered.**

Concretely, three independent defects:

**D1 — removal timer ignores delivery and consumption.**
`manager.ts:2745-2747` starts a fixed 10-minute clock at queue time. A wake deferred
through the flush-runner's reschedule paths burns that budget while undelivered. By
the time the reminder reaches the parent, the task may be at or past removal. Nothing
extends retention on delivery, and `recordBackgroundOutputConsumption` does not
influence it.

**D2 — mid-batch wakes have no defer ceiling.**
`shouldReply === false` for a non-final success (`manager.ts:2705`), and
`shouldForceDispatchAfterActiveDefer` (`parent-wake-flush-runner.ts:256-258`) only
forces `shouldReply` wakes. A continuously busy parent can starve those wakes
indefinitely. Fits batch 1 exactly.

**D3 — the notification's own instruction is not honoured by the store.**
The `[ALL BACKGROUND TASKS COMPLETE]` text tells the agent to call
`background_output(task_id=...)` for each ID. In batch 2 that instruction was
followed immediately and still returned `Task not found` for all four. Either the
notification is emitted from a snapshot taken before removal, or removal ran between
emission and the tool call. Either way the contract is broken: **a task named in a
completion notification must be retrievable for a bounded window after it.**

The duplicate `[ALL BACKGROUND TASKS COMPLETE]` after the failed reads points at the
retained/requeued-wake logic (`dropAdmittedWakeConsumedByParent` at `:192-203`,
`deferReplyWakeWhileUnsafe` at `:170-182`) re-firing a wake whose tasks are already
gone — worth confirming as a fourth defect once D1–D3 are pinned.

---

## Reproduce first

There is no existing test for "notification names a task that is then unretrievable".
Coverage today is `task-completion-cleanup.test.ts` (asserts the timer *delay* is
`TASK_CLEANUP_DELAY_MS`, at `:318`, `:335`, `:899`) and
`completed-task-retrievability.test.ts` (the closest neighbour — read it first).

Write the failing test before touching anything:

1. **D3 harness** — launch N tasks against a fake client, complete them, capture the
   emitted notification payload, extract every `bg_*` ID from it, and assert
   `manager.getTask(id)` is defined for each. This is the contract. It should be
   red today under the right timing.
2. **D1 harness** — with fake timers, queue a wake, hold the parent "active" so the
   flush reschedules, advance past `TASK_CLEANUP_DELAY_MS`, then let the flush
   succeed. Assert the task is still retrievable when the reminder lands.
3. **D2 harness** — one of three tasks completes (`allComplete === false`, so
   `shouldReply === false`), parent never idles. Assert the wake is eventually
   dispatched rather than deferred forever.

`task-completion-cleanup.test.ts` already has the fake-timer rig
(`FakeTimers`, `getDelay`/`advanceBy`/`runNext`) and a `PromptAsyncCall` capture
type — reuse them rather than building new ones.

---

## Fix direction (not prescriptive — confirm with the tests first)

- **D1**: do not schedule removal at queue time. Schedule it on *delivery
  confirmation* (the `trackDispatchedWake` path), or make removal refuse to run while
  a wake for that task is still pending/in-flight. The sibling-aware reschedule at
  `:2360-2371` is the right shape; it just keys on the wrong condition.
- **D3**: cheapest correct guarantee — have the notification builder pin every task
  it names, and release the pin on `background_output` consumption or a bounded grace
  window. `recordBackgroundOutputConsumption` is already wired and unused for this.
- **D2**: give non-`shouldReply` wakes a defer ceiling too, or fold mid-batch wakes
  into the final `allComplete` wake instead of queuing them separately.
- Consider making `formatTaskNotFoundMessage` distinguish *evicted* from
  *never-existed* — it currently blames cross-instance state, which sent this
  investigation down a wrong path initially.

**Do not** simply raise `TASK_CLEANUP_DELAY_MS`. It converts a loud failure into a
rare one and leaves the ordering bug intact.

---

## Constraints

- **Worktree discipline** (`.omo/rules/worktrees.md`): do the fix in
  `.worktrees/<slug>`, never on `main` directly.
- `manager.ts` is **3259 lines / 120 KB** — over the 100 KB `ctx_read` ceiling. Use
  windowed reads (`offset`/`limit`) or `rg`; an unbounded read fails outright.
- Tests are `bun:test`. Run the focused file, not the whole suite.
- Registry state is on `globalThis` — `clearBackgroundTaskRegistryForTesting()`
  (`task-registry.ts:141-144`) exists for isolation; use it in `afterEach` or tests
  leak into each other.

## Key files

| File | Why |
|---|---|
| `src/features/background-agent/manager.ts` | `getTask` `:1067`, `removeTask` `:434`, `archiveCompletedTask` `:441`, `notifyParentSession` `:2627-2748`, `scheduleTaskRemoval` `:2348-2385` |
| `src/features/background-agent/task-registry.ts` | global 100-entry FIFO registry |
| `src/features/background-agent/parent-wake-flush-runner.ts` | 8 early-return defer/drop paths, defer ceiling `:256` |
| `src/features/background-agent/parent-wake-prompt-dispatch.ts` | actual `dispatchInternalPrompt`, requeue-on-failure `:106-111` |
| `src/features/background-agent/constants.ts` | `TASK_TTL_MS:4`, `TERMINAL_TASK_TTL_MS:5`, `TASK_CLEANUP_DELAY_MS:22` |
| `src/tools/background-task/create-background-output.ts` | `Task not found` text `:81-105`, 100 ms single retry `:50-79` |
| `src/features/background-agent/completed-task-retrievability.test.ts` | nearest existing coverage — read before writing new tests |

## Open questions

1. Which of the 8 flush-runner paths actually swallowed batch 1? Needs
   `[background-agent]` logs from a live repro — every branch logs distinctly.
2. Is the duplicate `[ALL BACKGROUND TASKS COMPLETE]` a separate retained-wake defect,
   or a symptom of D1?
3. Does `enableParentSessionNotifications` (`manager.ts:2695`) ever flip false
   mid-session? If so it is a fourth silent-drop path (`:2738-2743`).
