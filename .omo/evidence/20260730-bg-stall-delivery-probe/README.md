# Background stall delivery probe

## WHAT WAS TESTED

- **Clock override acceptance:** sandbox config with `background_task.taskTtlMs: 90000`; schema limit captured in [`blockers.log`](blockers.log). Intended proof: configuration-based 90-second compression required by task.
- **Genuine reported-`busy` silent-stall shape:** each independent run creates a zero-tool-call task with no progress for 91 seconds and session status `busy`; [`run-1.trace.log`](run-1.trace.log), [`run-2.trace.log`](run-2.trace.log), [`run-3.trace.log`](run-3.trace.log). Intended proof: whether `pruneStaleTasksAndNotifications` enters `onTaskPruned` for documented dead-stream shape.
- **Idle control:** same task and clock, status `idle`; same three traces. Intended proof: clock condition itself works when active-status guard does not suppress pruning.
- **Parent-wake dispatch control:** isolated `ParentWakeNotifier` with a safe idle parent, a failure wake, and captured `promptAsync`; same three traces. Intended proof: pending wake flush can reach prompt injection after a wake has been queued.
- **Existing unit coverage:** `bun test packages/omo-opencode/src/features/background-agent/task-poller.test.ts --test-name-pattern 'custom taskTtlMs|active session status'`; [`task-poller-unit.log`](task-poller-unit.log). Intended proof: custom TTL and active-status branch are executable in current checkout.
- **Isolation:** real DB/session count and real Codex config SHA-256 before and after isolated preparation/execution; [`isolation-before.log`](isolation-before.log), [`isolation-after.log`](isolation-after.log).

## WHAT WAS OBSERVED

### Q2 verdict

**Q2 = INCONCLUSIVE.**

Evidence: [`run-1.trace.log`](run-1.trace.log#L1-L10), [`run-2.trace.log`](run-2.trace.log#L1-L10), and [`run-3.trace.log`](run-3.trace.log#L1-L10) each record `busyPruned: []` for same 91-second silent task, while `idlePruned: ["stalled-1"]`. This isolates a detection-blocking branch matching `b505e8363`, but it is a direct in-process probe, not required real parent/child OpenCode session with a local mock model. It cannot establish delivery result for an actual pruned task.

Hop-by-hop trace, three independent runs:

| Hop | Run 1 | Run 2 | Run 3 | Evidence |
|---|---|---|---|---|
| `pruneStaleTasksAndNotifications` invoked | fired | fired | fired | `run-*.trace.log` JSON includes both branch results |
| active-status guard for silent `busy` child | fired | fired | fired | `busyPruned: []` |
| `onTaskPruned` | **not fired** | **not fired** | **not fired** | `busyPruned: []` |
| `markForNotification` | not reached | not reached | not reached | causal consequence of preceding hop |
| `enqueueNotificationForParent` | not reached | not reached | not reached | causal consequence of preceding hop |
| `notifyParentSession` | not reached | not reached | not reached | causal consequence of preceding hop |
| `queuePendingParentWake` | not reached | not reached | not reached | causal consequence of preceding hop |
| `parentWakeNotifier` flush | not reached from prune | not reached from prune | not reached from prune | separate idle-control dispatch recorded below |
| parent prompt injection | not reached from prune | not reached from prune | not reached from prune | separate idle-control dispatch recorded below |

Source causal proof: `task-poller.ts:67-70` skips a `running` task whenever session status is active; `session-status-classifier.ts:3` treats `busy` as active. `manager.ts:2862-2915` can only execute `onTaskPruned` after that helper permits it. `b505e8363` documents exact silent dead stream retained as `busy`.

Separate delivery control: each trace records `promptAsyncCallCount: 1` and `injectedParts: true` for a queued failure wake with an idle safe parent. This verifies test harness prompt-dispatch plumbing, not end-to-end prune delivery.

### Required 90-second configuration contradiction

[`blockers.log`](blockers.log#L1-L2) records schema rejection boundary: `BackgroundTaskConfigSchema` requires `taskTtlMs >= 300000`. Thus required `taskTtlMs ≈ 90000` configuration cannot load in this checkout. Source `task-poller.ts:38` does honor a supplied `taskTtlMs`; schema blocks that supplied value in real configuration. No source modified.

### Per-suspect finding

| Suspect | Verdict | Evidence |
|---|---|---|
| (a) WITHHOLDING | **not reached in faithful stall shape** | prune gate prevents `notifyParentSession`; `manager.ts:2647-2649` confirms completed summaries are withheld until `allComplete`, but no empirical live mid-flight sibling run was possible because required 90s config is invalid and no local mock-model harness exists. |
| (b) SUPERSESSION | **not reached in faithful stall shape** | prune gate prevents wake queue. `parent-wake-dedupe.ts:59-82` merge behavior was not claimed empirically. |
| (c) DEFERRAL | **not reached in faithful stall shape** | prune gate prevents wake queue. Separate source inspection identifies 60s active-defer ceiling in `parent-wake-flush-runner.ts:18,51-57,256-258`; not claimed as live end-to-end measurement. |

### External channel answer

No external away-from-keyboard channel fires on this prune path. `task-poller.ts:58` only removes toast tracking during terminal cleanup; `manager.ts:2911-2914` queues in-session notification. OpenClaw outbound wiring is session-event based in `plugin/event.ts`, not prune based. Therefore in-session parent prompt is only identified surface; it cannot satisfy away-from-keyboard notification need.

### Q3 healthy maximum no-activity gaps

| Shape | Maximum observed no-activity gap | Status/reason |
|---|---:|---|
| Long `bun test` run | not measured | Harness blocker: required real local mock model/session driver unavailable. |
| Large webfetch | not measured | Harness blocker: required real local mock model/session driver unavailable. |
| Deep research pass | not measured | Harness blocker: required real local mock model/session driver unavailable. |

### Isolation

- Real OpenCode DB `session` count: **1000 before, 1000 after**.
- Real `~/.codex/config.toml` SHA-256: **`29dcef97c44388e1c40949f17f0c0d92c5af0fd3635af8e83667d1e0df0b127c` before and after**.
- Exact captures: [`isolation-before.log`](isolation-before.log), [`isolation-after.log`](isolation-after.log).

## WHY IT IS ENOUGH

Three independent executions prove reported `busy` silently stalled task does not reach prune callback in direct system-component invocation. This is high-confidence detection evidence, but verdict remains INCONCLUSIVE because task requires real OpenCode parent/child sessions, event wire proof, and a local mock-model stall.

Additional access needed to settle Q2: a supported local mock model that can open a child stream and intentionally withhold all chunks without closing, plus either schema-accepted short `taskTtlMs` or permission to wait five minutes. Then drive server/SSE with linked sessions, capture `message.part.updated` and injected parent prompt, and repeat sibling/active-parent scenarios.

Evidence-only diff stat: [`git-diff-stat.log`](git-diff-stat.log) records no production-source modification after worktree restoration; evidence files are ignored by default and force-added only for this evidence-only PR.

## WHAT WAS OMITTED

- No tokens, auth headers, environment dumps, or provider credentials captured.
- No real OpenCode process spawned: 90-second config required by task conflicts with current schema minimum, and installed QA self-check also lacks `tmux`.
- No fabricated Q3 values or full end-to-end delivery claim.
