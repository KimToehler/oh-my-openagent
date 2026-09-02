# Task 5: `tryCompleteTask()` concurrent-entry atomicity finding

VERDICT: UNSAFE

## Scope and conclusion

`tryCompleteTask()` is safe only for callers that arrive **after** its synchronous terminal mutation. It does not serialize all terminal paths. In particular, `cancelTask()` awaits child abort before mutating status, while `tryCompleteTask()` mutates completion synchronously; both paths can pass their own pre-await `running` checks, then overwrite terminal state and independently run cleanup/notification tails. No per-task lock or in-flight completion claim covers this chain.

Todo 8 must add only this guard: `private readonly completingTaskIds = new Set<string>()`; at entry to `tryCompleteTask()`, synchronously reject when `task.status !== "running" || completingTaskIds.has(task.id)`, then synchronously add `task.id` before any `await`; remove it in that method's outer `finally`. `cancelTask()` must use same synchronous claim before its `await abortSessionWithLogging()` and release in `finally`, so completion and cancellation share one ownership gate. This is minimal: no redesign of parent-wake or poller internals.

## 1. Terminal-status guard and await boundary

- `manager.ts:2560-2565` reads `task.status` and returns when non-running. No `await` precedes this guard.
- `manager.ts:2575-2585` reserves notification preparation then mutates task terminal status synchronously, also before any `await`. Therefore two simultaneous `tryCompleteTask()` invocations cannot both pass this method's guard in JavaScript's run-to-completion execution: first invocation flips status before yielding; second sees `completed`.
- `manager.ts:2615-2623` contains first awaits, child abort then pane-deletion callback. No `await` exists between `tryCompleteTask()` guard and completion mutation.
- This does **not** settle cross-path safety. `manager.ts:2408-2442` lets `cancelTask()` read `running`, then await `abortSessionWithLogging()` before status mutation at `manager.ts:2447-2455`. While cancellation waits, `tryCompleteTask()` can complete. After cancellation resumes it unconditionally finalizes cancellation, because it does not re-check status after await. This is stale-state mutation.

## 2. Side-effect chain under double entry

| Effect | Evidence | Double-fire assessment |
| --- | --- | --- |
| Terminal status / completion timestamp | `manager.ts:2580-2586`; cancellation writes terminal state at `manager.ts:2447-2455` after its await | Harmful across completion/cancellation: stale cancellation can overwrite `completed` with `cancelled`, result/error metadata and final user state disagree. Two `tryCompleteTask()` calls alone are safe because status changes before first await. |
| Task history record | `manager.ts:2587`; cancellation record `manager.ts:2456-2459` | Harmful: records conflicting terminal outcomes for same task. |
| Root-descendant decrement | completion `manager.ts:2589-2591`; cancellation `manager.ts:2456-2458`; decrement implementation `manager.ts:391-399` | Harmful accounting race. `unregisterRootDescendant()` clamps at deletion when count is <=1, so no negative map value. But completion and cancellation both can call it after concurrent pre-await running observations; when root has other descendants, count can decrement twice, undercount live descendants. Stale/prune paths add same risk: `manager.ts:2913-2925` mutates and decrements without shared claim. |
| Toast cleanup / idle-timer cleanup | completion `manager.ts:2593-2607`; cancellation `manager.ts:2466-2478` | Largely idempotent: deleting missing tracking/timer or clearing absent timer does not create duplicate external result. Not enough to protect other effects. |
| Concurrency slot release | completion `manager.ts:2595-2599`; cancellation `manager.ts:2461-2464` | Usually guarded by shared mutable `task.concurrencyKey`: first terminal path releases then sets `undefined` before await, later path skips. Harmless for this specific interleaving, assuming no other mutation restores key. Not an atomic task-completion guard. |
| Subagent identity teardown | completion `manager.ts:2609-2613`; cancellation partial teardown `manager.ts:2440-2446` | Deletes/removes are idempotent enough, but cancellation can complete after completion's abort and re-run cleanup. Harmless in isolation; does not prevent stale terminal rewrite. |
| Session abort / pane deletion | completion awaits at `manager.ts:2615-2623`; cancellation aborts at `manager.ts:2440-2446` | Potentially duplicate abort and deletion callback. Abort may be tolerated, but two external teardown requests are not positively prevented. |
| Parent notification and wake enqueue | completion queues serialized notification at `manager.ts:2631-2637`; cancellation queues at `manager.ts:2492-2499`; `notifyParentSession()` appends summary at `manager.ts:2663-2672`, determines all-complete at `manager.ts:2674-2698`, then queues wake at `manager.ts:2716-2758` | Harmful. Each terminal path can enqueue notification for same task. Parent queue serializes execution, not semantic deduplication. Parent-wake content dedupe only removes byte-identical notifications before dispatch (`parent-wake-dedupe.ts:59-82`); completed vs cancelled messages differ. User can receive duplicate/conflicting result notification. |

## 3. Existing common-case guards

- `session-idle-event-handler.ts:28-29` ignores idle event when session has no registered task or task is not running. This guard is synchronous with its initial lookup; idle event for unregistered sync session is ignored.
- `session-idle-event-handler.ts:54-77` rechecks `task.status` after each asynchronous validation/todo operation. These guards are not held locks, but prevent common idle completion when another path already changed status.
- `task-poller.ts:218-223` initially skips non-running tasks. `task-poller.ts:303-304` rechecks status after its awaited activity refresh. `manager.ts:3059-3063` repeats running/session guards before poll completion, and `manager.ts:3130-3139` rechecks after awaited output validation. These reduce normal poller versus idle races.
- `manager.ts:3030-3033,3145-3150` serializes poller ticks with `pollingInFlight`, but does not serialize idle-event callbacks or `cancelTask()` against poller work.

Conclusion for common case: safe enough when one path completes first and the other reaches an existing status recheck later. Refuted as full safety: cancellation has a pre-await status check and no post-abort recheck, so it can race completion.

## 4. Per-task serialization search

- No per-task mutex, completion in-flight set, or task-id promise chain exists around `tryCompleteTask()`.
- `manager.ts:3250-3278` implements `notificationQueueByParent`: operations serialize only by `parentSessionID`, after terminal mutation and teardown. It does not cover `tryCompleteTask()` ownership, cancellation mutation, root decrement, abort, identity teardown, or task-history write.
- `manager.ts:662-758` uses `processingKeys` only for launch queue processing, not completion.
- `manager.ts:3030-3033` uses `pollingInFlight` only to avoid overlapping poller loops, not event/cancel completion paths.

## Adversarial classes

- **misleading_success_output:** status guard in `tryCompleteTask()` is synchronous with its own mutation and safe for two calls to that one method. It does not protect cancellation because cancellation yields at `manager.ts:2440-2442` after its check, then writes stale status at `manager.ts:2447-2455`.
- **stale_state:** cancellation's running observation can become stale while abort awaits; it then overwrites completion and continues terminal effects.
- **repeated_interruptions:** completion and cancellation both call `unregisterRootDescendant`; stale prune path also decrements at `manager.ts:2919-2925`. Clamp avoids negative count but does not prevent double-decrement when root count exceeds one.

## How I checked

Read exact ranges:

- `.omo/plans/bounded-sync-delegation.md:150-195`
- `packages/omo-opencode/src/features/background-agent/manager.ts:330-419,560-759,1125-1195,2380-2659,2890-3150,3250-3278`
- `packages/omo-opencode/src/features/background-agent/session-idle-event-handler.ts:1-97`
- `packages/omo-opencode/src/features/background-agent/task-poller.ts:1-336`
- `packages/omo-opencode/src/features/background-agent/parent-wake-dedupe.ts:53-82`
- `packages/omo-opencode/src/features/background-agent/parent-wake-notifier.ts:88-121`
- `packages/omo-opencode/src/features/background-agent/manager.test.ts:2381-2450`

Ran:

```text
git status --porcelain packages/
 M packages/omo-codex/plugin/components/codegraph/dist/cli.js
 M packages/omo-codex/scripts/install-dist/install-local.mjs
 M packages/omo-opencode/src/config/schema/background-task.ts
 M packages/omo-opencode/src/tools/delegate-task/timing.test.ts
 M packages/omo-opencode/src/tools/delegate-task/timing.ts
 M packages/omo-senpi/plugin/extensions/omo-member.js
 M packages/omo-senpi/plugin/extensions/omo.js
 M packages/prompts-core/prompts/atlas/default.md
 M packages/prompts-core/prompts/atlas/gemini.md
 M packages/prompts-core/prompts/atlas/glm.md
 M packages/prompts-core/prompts/atlas/gpt.md
 M packages/prompts-core/prompts/atlas/kimi-k2-7.md
 M packages/prompts-core/prompts/atlas/kimi-k3.md
 M packages/prompts-core/prompts/atlas/kimi.md
 M packages/prompts-core/prompts/atlas/opus-4-7.md
```

Output contains pre-existing parallel-work changes. Investigation modified no file under `packages/`; only this evidence file was written. User-stated four unrelated files are included within wider current workspace changes, all untouched.

## Could not determine

- Exact behavior of underlying client abort when invoked twice. Code does not positively prevent duplicate abort requests.
- Whether every completion/cancellation notification string is byte-identical for a specific task. `completed` and `cancelled` status paths construct distinct status text, so parent-wake content dedupe cannot be relied on for this race.
- Exact ownership/ordering of external stale-prune and cancellation triggers. Their independent terminal writes/decrements lack shared per-task claim, sufficient for unsafe verdict.
