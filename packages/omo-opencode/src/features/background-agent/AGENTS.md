# src/features/background-agent/ - Core Orchestration Engine

**Generated:** 2026-05-20

## OVERVIEW

50 non-test files (~110 `.ts` total incl. tests + `spawner/`). Manages async task lifecycle: launch → queue → run → poll → complete/error. Concurrency limited per model/provider (default 5). Central to multi-agent orchestration.

## TASK LIFECYCLE

```
LaunchInput → pending → [ConcurrencyManager queue] → running → polling → completed/error/cancelled/interrupt
```

## KEY FILES

| File | Purpose |
|------|---------|
| `manager.ts` | `BackgroundManager` — main class (3.2k LOC, the production hotspot): launch, cancel, resume, getTask, listTasks, event handling, stale cleanup, archive |
| `spawner.ts` | Task spawning: create session → inject prompt → start polling |
| `concurrency.ts` | `ConcurrencyManager` - FIFO queue per concurrency key, slot acquisition/release |
| `task-poller.ts` | 3s interval polling, completion via idle events + stability detection (10s unchanged) |
| `types.ts` | `BackgroundTask`, `LaunchInput`, `ResumeInput`, `BackgroundTaskStatus` |
| `parent-wake-notifier.ts` | Coordinates parent-session wake notification; queue/dedupe/dispatch/history/activity/recovery helpers are split into sibling `parent-wake-*.ts` modules |
| `loop-detector.ts` | Detects polling/event loops that would otherwise burn budget. |
| `error-classifier.ts` | Maps raw provider errors → `BackgroundTaskError` categories. |
| `fallback-retry-handler.ts` | Coordinates retries with the runtime-fallback system. |
| `process-cleanup.ts` | Best-effort cleanup on parent exit. `OMO_DISABLE_PROCESS_CLEANUP=1` opts out entirely. |
| `subagent-spawn-limits.ts` | Enforces per-parent subagent spawn caps. |
| `session-status-classifier.ts` | Normalizes OpenCode session status across versions. |
| `compaction-aware-message-resolver.ts` | Resolves task result content even across mid-task compaction. |
| `attempt-lifecycle.ts` | Tracks retry attempts on a single task. |
| `task-history.ts` | Append-only history for completed tasks. |
| `session-idle-event-handler.ts` | Bridges OpenCode `session.idle` → task-poller completion signal. |
| `session-existence.ts` | Cheap existence check used by recovery code. |
| `abort-with-timeout.ts` | Force-abort tasks past `syncPollTimeoutMs`. |
| `remove-task-toast-tracking.ts` | Strips lingering toast tracker entries on task end. |
| `background-task-notification-template.ts` | Template for parent-session result injection. |

## SPAWNER SUBDIRECTORY

| File | Purpose |
|------|---------|
| `spawner-context.ts` | `SpawnerContext` interface composing all spawner deps |
| `background-session-creator.ts` | Create OpenCode session for background task |
| `concurrency-key-from-launch-input.ts` | Derive concurrency key from model/provider |
| `tmux-callback-invoker.ts` | Notify TmuxSessionManager on session creation |

## COMPLETION DETECTION

Two signals combined:
1. **Session idle event**: OpenCode reports session became idle
2. **Stability detection**: message count unchanged for 10s (3+ stable polls at 3s interval)

Both must agree before marking a task complete. Prevents premature completion on brief pauses.

### Todo-completion gate is bounded, not indefinite

The poll loop also waits on a task's own todo list before completing it (`manager.ts` around lines 3365-3368): while `checkSessionTodos` reports incomplete todos, the task stays `running`. That wait is bounded by a grace window, config key `background_task.todoGateGraceMs` (`config/schema/background-task.ts`, default 600000 ms / 10 minutes, `.min(60000)`), constrained by a `superRefine` guard that requires `todoGateGraceMs` to stay below `taskTtlMs`. When a task has been continuously idle with valid session output but non-terminal todos for longer than the grace window, it completes through the normal `tryCompleteTask` path instead of waiting indefinitely, and the completion notification is annotated with the count of unfinished todos (`unfinishedTodoCount` on `BackgroundTask`, `types.ts`).

### Lanes also report the uncommitted work they leave behind

A lane reads `git status --porcelain -z --untracked-files=all` at launch and again when it ends, and reports the DELTA (`uncommittedFileCount` on `BackgroundTask`, `dirty-worktree.ts`), so dirt that predates the lane is excluded. `--untracked-files=all` is load-bearing: plain `--porcelain` collapses a new directory to one `?? dir/` entry, so a lane creating five files would report one, and a lane adding to an already-untracked directory would report nothing at all.

Three properties this path must keep:
- **The launch read is not awaited.** It spawns `git`, and launch is on the critical path to `running`; awaiting it delayed dispatch enough to leave tasks observably `pending`. The promise takes its `.catch` at the creation site, because only the completion path ever awaits it, so a cancelled or interrupted lane would otherwise leave a rejection unobserved.
- **The completion read is bounded and total.** It sits inside `tryCompleteTask` between the notification reservation and `markForNotification`, so an unbounded read would stall the poll loop for every lane and a throwing one would drop the parent notification. It has a 5s timeout and contains all failures.
- **Cancelled lanes report too.** `cancelTask` takes the same reading before retiring the task, and the summary line carries the count on non-completed statuses. An interrupted lane is the likeliest to have stranded work; gating the count on `status === "completed"` made it the one lane that stayed silent.

Todo terminalization is not guaranteed by any producer: nothing obliges a subagent to mark its own todos terminal before going idle, since that depends on the subagent's own judgement rather than a contract the harness can enforce. That is the reason the gate is bounded by time instead of by a stricter producer contract.

Two known limits on the bound:
- **Status unavailable**: when the session status map (`allStatuses`) comes back `undefined` for a poll cycle, the loop continues before reaching the todo gate (`manager.ts:3335`, `if (allStatuses === undefined) { continue }`). On that cycle the gate's stamp is never set, so the bound cannot start counting for the task, while age-based task pruning keeps running on its own independent schedule.
- **Plugin-restart orphan**: the poll loop and all in-memory task state live in the running plugin process. If the runtime restarts, that state is gone, and the task record itself (status, attempt history, fallback chain, concurrency slot) cannot be recovered. Continuation is recoverable, though: on a `findBySession` miss, `resume()` now adopts the live child session instead of failing outright (`manager.ts:1396-1440`). Liveness policy: `active`/`unknown` refuse, `terminal` adopts, `absent` adopts only if `validateSessionHasOutput` confirms the transcript already holds real assistant/tool output. Two guards sit on that path: a session may not adopt itself (`sessionId === parentSessionId` is refused before any I/O), and an adopted resume dispatches with `checkToolState: false`, because an orphan killed mid-turn ends in an unterminated assistant turn that the gate's shape check would otherwise treat as still-running. The gate's own liveness check (`checkStatus`) stays enabled, so a session that is genuinely active is still refused. An adopted task carries no original model, fallback chain, category, or skill content, and a task that dies while still `pending` (never spawned, so it has no `sessionId`) has no session to adopt.

## CONCURRENCY MODEL

- Key format: `{providerID}/{modelID}` (e.g., `anthropic/claude-opus-4-7`)
- Default limit: 5 concurrent per key (configurable via `background_task` config)
- FIFO queue: tasks wait in order when slots full
- Slot released on: completion, error, cancellation

## NOTIFICATION FLOW

```
task completed → result-handler → parent-session-notifier → inject system message into parent session
```
