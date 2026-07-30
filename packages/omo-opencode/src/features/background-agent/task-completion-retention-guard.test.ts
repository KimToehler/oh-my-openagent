import { tmpdir } from "node:os"
import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { TASK_CLEANUP_DELAY_MS } from "./constants"
import { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"
import { releaseAllPromptAsyncReservationsForTesting } from "../../hooks/shared/prompt-async-gate"

type PromptAsyncCall = {
  path: { id: string }
  body: {
    noReply?: boolean
    parts?: unknown[]
  }
  query?: { directory: string }
}

type FakeTimers = {
  getDelay: (timer: ReturnType<typeof setTimeout>) => number | undefined
  run: (timer: ReturnType<typeof setTimeout>) => Promise<void>
  advanceBy: (ms: number) => Promise<void>
  runNext: () => Promise<boolean>
  restore: () => void
}

type PendingParentWakeForTest = {
  notifications: string[]
  shouldReply: boolean
}

let managerUnderTest: BackgroundManager | undefined
let fakeTimers: FakeTimers | undefined

afterEach(() => {
  managerUnderTest?.shutdown()
  fakeTimers?.restore()
  releaseAllPromptAsyncReservationsForTesting()
  managerUnderTest = undefined
  fakeTimers = undefined
})

function createTask(overrides: Partial<BackgroundTask> & { id: string; parentSessionId: string }): BackgroundTask {
  const id = overrides.id
  const parentSessionID = overrides.parentSessionId
  const { id: _ignoredID, parentSessionId: _ignoredParentSessionID, ...rest } = overrides

  return {
    parentMessageId: overrides.parentMessageId ?? "parent-message-id",
    description: overrides.description ?? overrides.id,
    prompt: overrides.prompt ?? `Prompt for ${overrides.id}`,
    agent: overrides.agent ?? "test-agent",
    status: overrides.status ?? "running",
    startedAt: overrides.startedAt ?? new Date("2026-03-11T00:00:00.000Z"),
    ...rest,
    id,
    parentSessionId: parentSessionID,
  }
}

function createManager(sessionMessages: { info?: { role?: string; time?: { created?: number } }; parts?: Array<{ type?: string }> }[] = []): {
  manager: BackgroundManager
  promptAsyncCalls: PromptAsyncCall[]
} {
  if (!fakeTimers) {
    fakeTimers = installFakeTimers()
  }

  const promptAsyncCalls: PromptAsyncCall[] = []
  const client = {
    session: {
      messages: async () => sessionMessages,
      status: async () => ({ data: {} }),
      prompt: async () => ({}),
      promptAsync: async (call: PromptAsyncCall) => {
        promptAsyncCalls.push(call)
        return {}
      },
      abort: async () => ({}),
    },
  }
  const ctx: PluginInput = {
    client: client as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory: tmpdir(),
    worktree: tmpdir(),
    serverUrl: new URL("http://localhost"),
    $: {} as PluginInput["$"],
  }

  const manager = new BackgroundManager({
    pluginContext: ctx,
    config: undefined,
    enableParentSessionNotifications: true,
  })

  return { manager, promptAsyncCalls }
}

function installFakeTimers(): FakeTimers {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const originalDateNow = Date.now
  const callbacks = new Map<ReturnType<typeof setTimeout>, () => void | Promise<void>>()
  const delays = new Map<ReturnType<typeof setTimeout>, number>()
  const dueTimes = new Map<ReturnType<typeof setTimeout>, number>()
  let now = Date.now()

  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]): ReturnType<typeof setTimeout> => {
    if (typeof handler !== "function") {
      throw new Error("Expected function timeout handler")
    }

    const timer = originalSetTimeout(() => {}, 60_000)
    originalClearTimeout(timer)
    const callback = handler as (...callbackArgs: Array<unknown>) => void
    callbacks.set(timer, () => callback(...args))
    const normalizedDelay = Math.max(0, delay ?? 0)
    delays.set(timer, normalizedDelay)
    dueTimes.set(timer, now + normalizedDelay)
    return timer
  }) as typeof setTimeout

  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>): void => {
    callbacks.delete(timer)
    delays.delete(timer)
    dueTimes.delete(timer)
  }) as typeof clearTimeout
  Date.now = () => now

  return {
    getDelay(timer) {
      return delays.get(timer)
    },
    async run(timer) {
      const callback = callbacks.get(timer)
      if (!callback) {
        throw new Error(`Timer not found: ${String(timer)}`)
      }

      now = dueTimes.get(timer) ?? now
      callbacks.delete(timer)
      delays.delete(timer)
      dueTimes.delete(timer)
      await callback()
      await flushMicrotasks()
    },
    async advanceBy(ms) {
      const target = now + ms
      while (true) {
        const nextTimer = nextTimerDueBefore(target)
        if (!nextTimer) break
        await this.run(nextTimer)
      }
      now = target
      await flushMicrotasks()
    },
    async runNext() {
      const nextTimer = nextTimerDueBefore(Number.POSITIVE_INFINITY)
      if (!nextTimer) {
        await flushMicrotasks()
        return false
      }
      await this.run(nextTimer)
      return true
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
      Date.now = originalDateNow
    },
  }

  function nextTimerDueBefore(target: number): ReturnType<typeof setTimeout> | undefined {
    return [...dueTimes.entries()]
      .filter(([, dueAt]) => dueAt <= target)
      .sort((left, right) => left[1] - right[1])[0]?.[0]
  }
}

function getTasks(manager: BackgroundManager): Map<string, BackgroundTask> {
  return Reflect.get(manager, "tasks") as Map<string, BackgroundTask>
}

function getPendingByParent(manager: BackgroundManager): Map<string, Set<string>> {
  return Reflect.get(manager, "pendingByParent") as Map<string, Set<string>>
}

function getPendingParentWakes(manager: BackgroundManager): Map<string, PendingParentWakeForTest> {
  const parentWakeNotifier = Reflect.get(manager, "parentWakeNotifier") as {
    getPendingParentWakes: () => Map<string, PendingParentWakeForTest>
  }
  return parentWakeNotifier.getPendingParentWakes()
}

function getDispatchedParentWakes(manager: BackgroundManager): Map<string, PendingParentWakeForTest> {
  const parentWakeNotifier = Reflect.get(manager, "parentWakeNotifier") as {
    getDispatchedParentWakes: () => Map<string, PendingParentWakeForTest>
  }
  return parentWakeNotifier.getDispatchedParentWakes()
}

function markParentWakeInFlight(manager: BackgroundManager, sessionID: string): void {
  const parentWakeNotifier = Reflect.get(manager, "parentWakeNotifier") as {
    dispatchedTracker: { markInFlight: (sessionID: string) => void }
  }
  parentWakeNotifier.dispatchedTracker.markInFlight(sessionID)
}

function getCompletionTimers(manager: BackgroundManager): Map<string, ReturnType<typeof setTimeout>> {
  return Reflect.get(manager, "completionTimers") as Map<string, ReturnType<typeof setTimeout>>
}

async function notifyParentSessionForTest(manager: BackgroundManager, task: BackgroundTask): Promise<void> {
  const notifyParentSession = Reflect.get(manager, "notifyParentSession") as (task: BackgroundTask) => Promise<void>
  return notifyParentSession.call(manager, task)
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve()
  }
}

function getRequiredTimer(manager: BackgroundManager, taskID: string): ReturnType<typeof setTimeout> {
  const timer = getCompletionTimers(manager).get(taskID)
  expect(timer).toBeDefined()
  if (timer === undefined) {
    throw new Error(`Missing completion timer for ${taskID}`)
  }

  return timer
}

describe("BackgroundManager completion cleanup retention guard", () => {
  test("#given a shouldReply wake is still owed when the cleanup timer fires #then task stays retrievable until the wake is consumed", async () => {
    // given: a single completed task whose notification is queued but never
    // dispatched (the exact Facet B scenario from
    // docs/handovers/2026-07-29-bg-task-notification-delivery-bug.md). The
    // orchestrator is blocked waiting for the wake; cleanup must not reap the
    // task before the orchestrator reads it.
    const { manager } = createManager()
    managerUnderTest = manager
    const task = createTask({
      id: "bg_retention_guard",
      parentSessionId: "parent-retention",
      description: "retention guard task",
      status: "completed",
      completedAt: new Date(),
      sessionId: "ses_retention_guard",
    })
    getTasks(manager).set(task.id, task)
    getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

    // when: notifyParentSession queues a shouldReply wake (allComplete === true)
    await notifyParentSessionForTest(manager, task)

    // then: wake is queued with shouldReply === true
    expect(getPendingParentWakes(manager).get(task.parentSessionId)?.shouldReply).toBe(true)

    // when: the cleanup timer fires
    const cleanupTimer = getRequiredTimer(manager, task.id)
    expect(fakeTimers?.getDelay(cleanupTimer)).toBe(TASK_CLEANUP_DELAY_MS)
    await fakeTimers?.run(cleanupTimer)

    // then: task is STILL in this.tasks (retention guard deferred removal) and
    // still retrievable via getTask. Without the guard this assertion fails —
    // the task is reaped and background_output returns "Task not found".
    expect(getTasks(manager).has(task.id)).toBe(true)
    expect(manager.getTask(task.id)?.id).toBe(task.id)
  })

  test("#given only a dispatched shouldReply wake is owed #when the cleanup timer fires #then the task stays retrievable", async () => {
    // given: a completed task whose wake has already left the pending queue.
    // parent-wake-flush-runner deletes the pending wake BEFORE dispatching
    // (parent-wake-flush-runner.ts:224-226) and only then tracks it as
    // dispatched, so "dispatched, nothing pending" is the ordinary steady state
    // of every reply dispatch - not an edge case.
    const { manager } = createManager()
    managerUnderTest = manager
    const task = createTask({
      id: "bg_retention_dispatched",
      parentSessionId: "parent-dispatched",
      description: "dispatched-only retention task",
      status: "completed",
      completedAt: new Date(),
      sessionId: "ses_retention_dispatched",
    })
    getTasks(manager).set(task.id, task)
    getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

    await notifyParentSessionForTest(manager, task)

    // when: the wake transitions from pending to dispatched, exactly as the
    // flush runner does it
    const pendingWake = getPendingParentWakes(manager).get(task.parentSessionId)
    expect(pendingWake?.shouldReply).toBe(true)
    if (pendingWake === undefined) throw new Error("Missing pending wake")
    getPendingParentWakes(manager).delete(task.parentSessionId)
    getDispatchedParentWakes(manager).set(task.parentSessionId, pendingWake)

    // then: nothing is pending, but a shouldReply wake is still owed
    expect(getPendingParentWakes(manager).has(task.parentSessionId)).toBe(false)
    expect(getDispatchedParentWakes(manager).get(task.parentSessionId)?.shouldReply).toBe(true)

    // when: the cleanup timer fires
    const cleanupTimer = getRequiredTimer(manager, task.id)
    await fakeTimers?.run(cleanupTimer)

    // then: the task survives. The orchestrator has been woken but has not yet
    // consumed the result, so reaping here reproduces the original
    // "Task not found" bug one step later in the dispatch lifecycle.
    expect(getTasks(manager).has(task.id)).toBe(true)
    expect(manager.getTask(task.id)?.id).toBe(task.id)
  })

  test("#given a wake dispatch is in flight #when the cleanup timer fires #then the task stays retrievable", async () => {
    // given: the flush runner has marked a dispatch in flight and removed the
    // pending wake, but sendParentWakePrompt has not resolved yet, so the
    // dispatched tracker is not populated. parent-wake-flush-runner.ts:216-222
    // documents this window and markInFlight exists precisely to cover it.
    const { manager } = createManager()
    managerUnderTest = manager
    const task = createTask({
      id: "bg_retention_inflight",
      parentSessionId: "parent-inflight",
      description: "in-flight retention task",
      status: "completed",
      completedAt: new Date(),
      sessionId: "ses_retention_inflight",
    })
    getTasks(manager).set(task.id, task)
    getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

    await notifyParentSessionForTest(manager, task)

    // when: the dispatch enters the in-flight window - neither map reports a wake
    markParentWakeInFlight(manager, task.parentSessionId)
    getPendingParentWakes(manager).delete(task.parentSessionId)

    expect(getPendingParentWakes(manager).has(task.parentSessionId)).toBe(false)
    expect(getDispatchedParentWakes(manager).has(task.parentSessionId)).toBe(false)

    // when: the cleanup timer fires inside that window
    const cleanupTimer = getRequiredTimer(manager, task.id)
    await fakeTimers?.run(cleanupTimer)

    // then: the task survives - a wake is genuinely owed, it is merely
    // unobservable through the two wake maps
    expect(getTasks(manager).has(task.id)).toBe(true)
    expect(manager.getTask(task.id)?.id).toBe(task.id)
  })

  test("#given the owed wake is consumed #when the cleanup timer fires again #then the task is removed", async () => {
    // given: retention is a deferral, not a reprieve. Once no wake is owed the
    // task must be reaped on the next cleanup pass, or the guard leaks tasks
    // until TASK_TTL_MS for every completed task.
    const { manager } = createManager()
    managerUnderTest = manager
    const task = createTask({
      id: "bg_retention_released",
      parentSessionId: "parent-released",
      description: "released retention task",
      status: "completed",
      completedAt: new Date(),
      sessionId: "ses_retention_released",
    })
    getTasks(manager).set(task.id, task)
    getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

    await notifyParentSessionForTest(manager, task)
    expect(getPendingParentWakes(manager).get(task.parentSessionId)?.shouldReply).toBe(true)

    // when: the first cleanup fires while the wake is still owed
    await fakeTimers?.run(getRequiredTimer(manager, task.id))
    expect(getTasks(manager).has(task.id)).toBe(true)

    // when: the orchestrator consumes the wake, then cleanup fires again
    getPendingParentWakes(manager).delete(task.parentSessionId)
    getDispatchedParentWakes(manager).delete(task.parentSessionId)
    await fakeTimers?.run(getRequiredTimer(manager, task.id))

    // then: nothing is owed, so the task is finally removed
    expect(getTasks(manager).has(task.id)).toBe(false)
  })
})
