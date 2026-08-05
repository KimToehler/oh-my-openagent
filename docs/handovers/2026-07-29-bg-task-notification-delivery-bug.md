# Handover — Background-task notification delivery + result retrievability bug

## Repo

- **Path**: `/Users/tim/git/oh-my-openagent`
- **HEAD**: `46a55adb1` `Merge pull request #6022 from code-yeongyu/fix/codex-v2-catalog-guards-qa`
- **Tree**: clean, no worktrees open.

## Bug — two facets of one delivery failure

When the orchestrator (Sisyphus, running in the onara repo) dispatched **two consecutive batches** of 4 parallel `explore`/`librarian` subagents via `task(run_in_background=true)`, both batches completed, but the parent session saw *different* failure modes — neither of which should be possible:

### Facet A — zero notifications (first batch)

Batch 1 (onara B4 investigation): 4 tasks (`bg_0e159856`, `bg_201edaf9`, `bg_5b54acde`, `bg_5cf99cc9`) all completed. The parent session received **zero** `<system-reminder>` notifications. The system's own contract — *"System notifies on completion… You WILL be notified when ALL complete"* — was violated. The orchestrator sat idle, believing the tasks were still running.

### Facet B — notifications arrive but results already reaped (second batch)

Batch 2 (this investigation): 4 tasks (`bg_244a1668`, `bg_a11565f2`, `bg_eaec1323`, `bg_6883d302`) all completed. This time the notifications **did** arrive (all four `<system-reminder>` blocks, including the `[ALL BACKGROUND TASKS COMPLETE]` summary). But `background_output(task_id=…)` on every one returned `Task not found` — the results had been reaped from all three storage tiers *before* the orchestrator could read them. The continuation sessions (`ses_…`) were also empty (`No assistant text output found in completed response.`), even though the subagents had done real work.

**Both facets are intermittent.** They reproduced differently across two consecutive batches in the same session, minutes apart, against the same code at HEAD.

## Root-cause map (where the evidence points)

The delivery path has three stages: **completion → notification dispatch → result retention**. The evidence exonerates the first and third stages and converges on the second.

### Stage 1 — Completion detection: WORKS

The task poller (`task-poller.ts`) reliably marks tasks terminal. The orchestrator saw all 8 tasks reach `completed` status. Both `notifyParentSession` invocations built correct notification payloads. No evidence of a missed status transition.

### Stage 2 — Notification dispatch: PRIMARY SUSPECT

This is the `parent-wake` system: a chain of `ParentWakeNotifier` → `ParentWakePendingQueue` → `ParentWakeFlushRunner` → `sendParentWakePrompt` → `dispatchInternalPrompt` (the `promptAsync` gate). It injects the `<system-reminder>` into the parent session via a fire-and-forget OpenCode SDK call.

**Why Facet A (zero notifications) happens:** the flush runner (`parent-wake-flush-runner.ts:23-122`) has at least **six** early-return deferral paths before it reaches `sendParentWakePrompt`:

| Line | Condition | Result |
|---|---|---|
| 31 | `!sessionActive` then becomes active after `settleAfterSessionIdle` | deferred |
| 47 | `dropAdmittedWakeConsumedByParent` returns true | **silently dropped** |
| 52 | `sessionActive && !forceDispatchAfterActiveDefer` | deferred |
| 61 | `deferReplyWakeWhileUnsafe` returns true | deferred as noReply |
| 80 | `toolWaitDecision.defer` + unsafe | sent as noReply (notification text injected but **no assistant turn**) |
| 93 | `isUserMessageInProgress` | sent as noReply |

When the orchestrator is mid-turn (which it is — it ended its response and is waiting), `isSessionActive` returns true, and the wake hits line 52: **deferred indefinitely**. The wake is re-enqueued via `schedulePendingParentWakeFlush` with a debounce delay, but if the parent session never goes idle (e.g., the orchestrator's turn timer is still ticking, or a subsequent tool call arrives), the flush is re-deferred on every retry until the wake is either dropped or the turn ends.

The critical gap: **when the wake is sent as `noReply: true` (lines 67, 87, 107), the notification text is injected into the session, but no assistant turn is triggered to process it.** The orchestrator — which is sitting at the end of its turn waiting for a `<system-reminder>` — never sees it, because the noReply injection doesn't fork a turn. The `<system-reminder>` only surfaces if the orchestrator's own turn happens to re-read session history.

**Why Facet B (notifications arrive but results reaped) happens:** `notifyParentSession` (manager.ts:2745-2746) calls `scheduleTaskRemoval(task.id)` unconditionally on terminal status, starting a `TASK_CLEANUP_DELAY_MS` (10 min default, per `constants.ts:22`) timer. When the timer fires, `scheduleTaskRemoval` (manager.ts:2348-2385) calls `removeTask`, which calls `archiveBackgroundTask` (moves to `completedTasks` in the global registry) and `this.tasks.delete`. The task is still retrievable via `getRegisteredBackgroundTask` — **unless** the registry has been cleared (e.g., by another `BackgroundManager` instance, or by `clearBackgroundTaskRegistryForTesting`, or by the 100-entry FIFO eviction in `trimCompletedTasks`).

But the tasks vanished in **<2 minutes**, not 10. That means either:
1. The `taskCleanupDelayMs` config is overridden to something much shorter than 10 min in the live opencode config (schema permits it at `config/schema/background-task.ts:25`, `min(60000)` — so as low as 60s), OR
2. A **second `BackgroundManager` instance** is running (e.g., from a previous opencode session in the same process, or a team-mode member) whose `shutdown()` at manager.ts:3179-3218 calls `this.tasks.clear()` + `forgetBackgroundTask` — and because the registry lives on `globalThis`, one instance's shutdown can reap another instance's tasks.

Option 2 is the stronger hypothesis: the `globalThis` registry (`task-registry.ts:28`) is shared across all `BackgroundManager` instances in the process. A `shutdown()` from a stale manager (e.g., a team-mode run that ended, or a hot-reloaded plugin) calls `forgetBackgroundTask` for *its* tasks, but if it has stale references or if task IDs overlap, it can delete tasks belonging to the active manager.

### Stage 3 — Result retention: registry is correct but fragile

`task-registry.ts` is a `globalThis`-scoped `Map<string, BackgroundTask>` with:
- `activeTasks`: lazy-evaluated thunks (`() => BackgroundTask`), so they reflect live mutations.
- `completedTasks`: cloned snapshots (`cloneRegisteredTask`), so they are immutable.
- FIFO eviction at 100 entries (`MAX_COMPLETED_TASK_REGISTRY_SIZE`).
- `forgetBackgroundTask(taskID)` deletes from both maps unconditionally.

The `getTask` method (manager.ts:1067-1069) checks three stores in order: `this.tasks` → `this.completedTaskArchive` → `getRegisteredBackgroundTask(id)` (the global registry). For `background_output` to return "Task not found", the task must be absent from **all three** — which means:
- `this.tasks` was cleared (by `removeTask` via the cleanup timer, or by `shutdown`)
- `this.completedTaskArchive` was never populated (because `archiveCompletedTask` at manager.ts:441-475 returns early if `task.sessionId` is falsy or status is running/pending — but terminal tasks should pass)
- `getRegisteredBackgroundTask` returned undefined (because `forgetBackgroundTask` was called, or the 100-entry cap evicted it, or a different process/instance owns the registry)

## Evidence trail (file:line)

```
Notification payload construction:
  packages/omo-opencode/src/features/background-agent/manager.ts:2627-2748
    notifyParentSession() — builds payload, calls queuePendingParentWake, then scheduleTaskRemoval

Notification dispatch chain:
  parent-wake-notifier.ts:108-117    queuePendingParentWake → schedulePendingParentWakeFlush
  parent-wake-flush-runner.ts:23-122 flushPendingParentWake — 6 deferral/drop paths
  parent-wake-prompt-dispatch.ts:31  sendParentWakePrompt — dispatchInternalPrompt (promptAsync gate)

Task removal timer:
  manager.ts:2348-2385   scheduleTaskRemoval — TASK_CLEANUP_DELAY_MS (10 min default)
  manager.ts:2374        removeTask — archiveBackgroundTask + this.tasks.delete
  constants.ts:22        TASK_CLEANUP_DELAY_MS = 10 * 60 * 1000

Registry (globalThis):
  task-registry.ts:28-40   getRegistry — globalThis scoped
  task-registry.ts:113-128 archiveBackgroundTask — terminal → completedTasks
  task-registry.ts:135-140 forgetBackgroundTask — deletes from both maps
  task-registry.ts:92-98   trimCompletedTasks — FIFO eviction at 100

background_output tool:
  tools/background-task/create-background-output.ts:50-79  getTaskWithMissingRetry (100ms retry)
  tools/background-task/create-background-output.ts:81-105 formatTaskNotFoundMessage
  tools/background-task/create-background-output.ts:107+   execute — returns "Task not found" if getTask fails
```

## What to investigate (for the fix session)

### Hypothesis 1 — `noReply` wake injections that never fork a turn (Facet A)

**Test**: Reproduce the exact scenario — orchestrator ends its turn with 4 background tasks running, parent session is `active` from the orchestrator's perspective (turn timer still ticking). Observe whether the wake is sent as `noReply: true` and whether the `<system-reminder>` appears in the session message history without triggering an assistant turn.

**Fix direction**: When `allComplete === true` (the `[ALL BACKGROUND TASKS COMPLETE]` case), the wake should **never** be sent as `noReply`. The `shouldReply` flag at manager.ts:2705 is `allComplete || isTaskFailure`, which is correct — but the flush runner can override it at lines 67/87/107 (`forceNoReply: true`) when it detects session activity. The fix: when `shouldReply` is true AND `allComplete` is true, skip the `forceNoReply` override regardless of session activity — the orchestrator is waiting for exactly this signal.

### Hypothesis 2 — `taskCleanupDelayMs` config override or multi-instance registry collision (Facet B)

**Test 1**: Check the live opencode config (`~/.config/opencode/opencode.json` or project `.opencode/opencode.json`) for a `backgroundTask.taskCleanupDelayMs` value. If it's set to 60000 (the schema minimum), that explains the <2 min reaping.

**Test 2**: Add logging to `forgetBackgroundTask` (task-registry.ts:135) that captures a stack trace on every call. Run the repro scenario and check whether a second manager instance (or a shutdown path) is calling it.

**Fix direction**: The registry should be **per-manager-instance**, not `globalThis`. Or — if `globalThis` is intentional for cross-instance sharing — `forgetBackgroundTask` must only delete tasks that belong to *this* manager instance (check `task.parentSessionId` against the manager's known sessions). The `shutdown()` path (manager.ts:3179-3218) already iterates `this.tasks.values()` — but if a second instance shuts down, it calls `forgetBackgroundTask` on its own tasks, and if those task IDs were shared or if the registry was already populated by a different instance, the delete is safe but the `getTask` lookup from the active instance returns undefined because it checks `this.tasks` first (now empty after the other instance's shutdown cleared `globalThis`).

Actually — re-reading `getTask` (manager.ts:1067-1068): `this.tasks.get(id) ?? this.completedTaskArchive.get(id) ?? getRegisteredBackgroundTask(id)`. The active manager's `this.tasks` is instance-scoped (manager.ts:269, `private tasks: Map<string, BackgroundTask>`). So a *different* instance's shutdown cannot clear *this* instance's `this.tasks`. The only way `getTask` returns undefined is if `this.tasks` no longer has the entry (cleanup timer fired) AND `this.completedTaskArchive` doesn't have it AND `getRegisteredBackgroundTask` returns undefined.

So the real question for Facet B: **why did the cleanup timer fire in <2 minutes instead of 10?** Check:
1. Config override: `rg 'taskCleanupDelayMs' ~/.config/opencode/ ~/.opencode/ .opencode/` in the onara repo.
2. The `rescheduleCount` logic at manager.ts:2367: `MAX_TASK_REMOVAL_RESCHEDULES = 6` (manager.ts:229). Each reschedule waits `TASK_CLEANUP_DELAY_MS`. But if `runningOrPendingSiblings.length === 0` (all 4 tasks completed around the same time), the reschedule guard doesn't fire — the task is removed on the *first* timer tick. That's still 10 minutes, not 2.

**Unless** the timer was scheduled with the wrong delay. Check `this.config?.taskCleanupDelayMs` — if the manager was constructed with `{ taskCleanupDelayMs: 60000 }`, that would explain it. Check the manager construction site.

### Hypothesis 3 — continuation session content loss (Facet B secondary symptom)

When `background_output` was called with `task_id` that returned "Task not found", the fallback path recovered the continuation session IDs (`ses_…`) and called `task(task_id="ses_…")` on each. All four returned `No assistant text output found in completed response.` — meaning the subagent sessions existed but had **no assistant messages**.

This suggests the subagent's *session* was also cleared, not just the task registry. The `scheduleTaskRemoval` at manager.ts:2376-2379 deletes `subagentSessions.delete(task.sessionId)` and `clearDelegatedChildSessionBootstrap(task.sessionId)`. But the session itself lives in the opencode session store (SQLite), not in the manager's in-memory map — so `subagentSessions.delete` shouldn't destroy the session data.

The `No assistant text output found` message likely comes from the continuation path reading an *empty* session. Check whether the subagent's session was aborted (manager.ts:2595, `abortSessionWithLogging`) before its final assistant message was persisted. If the abort races the assistant's final write, the session could be persisted without its result.

## How to reproduce

From the onara repo (or any repo with the opencode + oh-my-openagent plugin):

1. Start a Sisyphus session.
2. Dispatch 4 parallel `task(subagent_type="explore", run_in_background=true)` calls in one message.
3. End the response.
4. Wait for all 4 to complete.
5. Check: did `<system-reminder>` notifications arrive? (Facet A = no, Facet B = yes)
6. Call `background_output(task_id="bg_…")` on each.
7. Check: did results come back? (Facet B = "Task not found")

The bug is intermittent — it may take several runs to reproduce. The key variable seems to be whether the parent session is `active` (turn timer running) at the moment the wake flush attempts to dispatch.

## Existing test coverage (do not break)

- `task-completion-cleanup.test.ts` — 900+ lines, tests the cleanup timer with fake timers. Confirms `TASK_CLEANUP_DELAY_MS` delay. Does NOT test the interaction between cleanup timing and `background_output` retrievability.
- `completed-task-retrievability.test.ts` — explicitly tests the "Task not found" regression for failed tasks. Extends only to the `archiveBackgroundTask` call, not to the full `background_output` → `getTask` path under timer pressure.
- `parent-wake-noreply-liveness.test.ts` — tests the noReply wake path. Check whether it covers the `allComplete + shouldReply` override case.
- `parent-wake-flush-runner` tests (many: `parent-wake-active-defer-ceiling`, `parent-wake-assistant-text-deferral`, `parent-wake-user-message-race`, etc.) — individually test each deferral path, but may not test the *composition* where 4 tasks complete simultaneously and all hit the same deferral path.

## Key files for the fix

```
packages/omo-opencode/src/features/background-agent/
├── manager.ts                          # 3259 lines — notifyParentSession, scheduleTaskRemoval, getTask
├── task-registry.ts                    # 145 lines — globalThis registry, archive/forget/get
├── constants.ts                        # TASK_CLEANUP_DELAY_MS, TASK_TTL_MS
├── parent-wake-flush-runner.ts         # 293 lines — 6 deferral paths, the noReply override
├── parent-wake-prompt-dispatch.ts      # 131 lines — dispatchInternalPrompt, the actual SDK call
├── parent-wake-notifier.ts             # 193 lines — queuePendingParentWake, requeue logic
└── parent-wake-pending-queue.ts        # debounce/requeue

packages/omo-opencode/src/tools/background-task/
└── create-background-output.ts         # getTaskWithMissingRetry (100ms), formatTaskNotFoundMessage

packages/omo-opencode/src/config/schema/
└── background-task.ts                  # taskCleanupDelayMs schema (min 60000)
```

## Suggested approach

1. **Reproduce reliably first.** The intermittency is the biggest obstacle. Add temporary logging to `notifyParentSession`, `scheduleTaskRemoval`, `flushPendingParentWake`, and `forgetBackgroundTask` that captures task ID, parent session ID, session-active state, and timestamp. Run the 4-task repro until both facets reproduce.
2. **Fix Facet A first** (noReply override swallows allComplete notifications). This is the higher-impact bug — a silent failure that leaves the orchestrator permanently stuck. The fix is likely small: in `flushPendingParentWake`, when `latestWake.shouldReply && allComplete`, do not override with `forceNoReply`.
3. **Fix Facet B second** (result reaping before consumption). The fix is likely: extend `TASK_CLEANUP_DELAY_MS` OR make `background_output` check the durable session store as a fallback when the in-memory registry returns undefined OR add a "consumed" flag that delays cleanup until the orchestrator has called `background_output` at least once.
4. **Pin both with characterization tests** that compose the full path: task completes → wake dispatches → orchestrator reads result via `background_output`. The existing tests test slices; the bug lives in the composition.
