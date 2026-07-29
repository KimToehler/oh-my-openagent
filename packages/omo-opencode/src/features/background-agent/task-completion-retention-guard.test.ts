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
})
