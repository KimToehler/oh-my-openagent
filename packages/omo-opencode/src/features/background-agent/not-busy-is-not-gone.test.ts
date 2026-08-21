import { describe, expect, test } from "bun:test"
import { MIN_SESSION_GONE_POLLS } from "./session-existence"
import { checkAndInterruptStaleTasks } from "./task-poller"
import type { BackgroundTask } from "./types"

/**
 * Locks the invariant that absence from the `session.status()` map does NOT mean
 * the child is dead.
 *
 * Verified against a real `opencode serve` (1.18.15): the map contains only
 * `busy` / `retry` sessions. An idle-but-alive session is absent from it, and
 * `idle` never appears as a map value - it only exists as an SSE event payload.
 * So a healthy task waiting on the todo gate looks exactly like a dead one for
 * as long as it stays idle.
 *
 * `MIN_SESSION_GONE_POLLS` (3) at `POLLING_INTERVAL_MS` (3000) is therefore only
 * 9 seconds of not-being-busy, which is why the existence probe must stay: it is
 * the one signal that distinguishes the two, and dropping it would cancel
 * todo-gated tasks 60s into a grace period the config schema requires to be able
 * to last 10 minutes.
 */

function runningTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  const now = Date.now()
  return {
    id: "task-not-busy",
    sessionId: "ses-1",
    parentSessionId: "parent-1",
    parentMessageId: "message-1",
    description: "todo-gated task",
    prompt: "work through the todos",
    agent: "explore",
    status: "running",
    startedAt: new Date(now - 10 * 60_000),
    progress: { toolCalls: 3, lastUpdate: new Date(now - 5 * 60_000) },
    concurrencyGroup: "explore",
    ...overrides,
  } as BackgroundTask
}

function makeClient(rowExists: boolean) {
  return {
    session: {
      // The session is idle, so it is absent from the status registry entirely.
      status: async () => ({ data: {} }),
      get: async () =>
        rowExists ? { data: { id: "ses-1" } } : { error: { status: 404, message: "Session not found" } },
      abort: async () => ({ data: true }),
      messages: async () => ({ data: [] }),
    },
  }
}

const concurrencyManager = { release: () => {}, getConcurrencyKey: (key: string) => key } as never

async function poll(task: BackgroundTask, rowExists: boolean): Promise<void> {
  await checkAndInterruptStaleTasks({
    tasks: [task],
    client: makeClient(rowExists) as never,
    config: { staleTimeoutMs: 2_700_000, sessionGoneTimeoutMs: 60_000 },
    concurrencyManager,
    notifyParentSession: async () => {},
    sessionStatuses: {},
    getSessionActivity: async () => ({ type: "unavailable" }) as never,
  })
}

describe("absence from the session status map is not proof of death", () => {
  test("#given an idle live task past the gone threshold and the session-gone timeout #when polled #then it survives because its session row still resolves", async () => {
    // given - idle 5min: far past sessionGoneTimeoutMs (60s), far short of staleTimeoutMs (45min)
    const task = runningTask({ consecutiveMissedPolls: MIN_SESSION_GONE_POLLS } as Partial<BackgroundTask>)

    // when
    await poll(task, true)

    // then
    expect(task.status).toBe("running")
    expect(task.consecutiveMissedPolls).toBe(0)
  })

  test("#given the same task whose session row is genuinely gone #when polled #then the session-gone timeout does cancel it", async () => {
    // given
    const task = runningTask({ consecutiveMissedPolls: MIN_SESSION_GONE_POLLS } as Partial<BackgroundTask>)

    // when
    await poll(task, false)

    // then
    expect(task.status).toBe("cancelled")
    expect(task.error).toContain("session gone from status registry")
  })

  test("#given an idle live task polled repeatedly #when it stays idle for a todo-gate grace period #then it is never cancelled", async () => {
    // given - 10min of idling, the schema-mandated todoGateGraceMs default
    const task = runningTask({
      progress: { toolCalls: 3, lastUpdate: new Date(Date.now() - 10 * 60_000) },
    } as Partial<BackgroundTask>)

    // when - 200 polls is 10 minutes at POLLING_INTERVAL_MS
    for (let i = 0; i < 200; i += 1) {
      await poll(task, true)
      if (task.status !== "running") break
    }

    // then
    expect(task.status).toBe("running")
  })
})
