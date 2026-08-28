import { afterEach, describe, expect, jest, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"

type ManagerInternals = {
  readonly parentWakeNotifier: {
    readonly getPendingParentWakes: () => Map<string, { readonly notification: string; readonly shouldReply: boolean }>
  }
  readonly tasks: Map<string, BackgroundTask>
  readonly pendingByParent: Map<string, Set<string>>
  readonly expireBlockedTask: (taskId: string) => void
}

const managers: BackgroundManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown()
  jest.useRealTimers()
})

function createManager(blockedExpiryMs = 100): BackgroundManager {
  const manager = new BackgroundManager({
    pluginContext: unsafeTestValue<PluginInput>({
      client: {
        session: {
          abort: async () => ({ data: true }),
          messages: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
        },
      },
      directory: "/tmp/blocked-expiry-notification",
    }),
    config: unsafeTestValue({ blockedRewakeMs: blockedExpiryMs * 2, blockedExpiryMs }),
  })
  managers.push(manager)
  return manager
}

function createBlockedTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "expired-blocked-task",
    sessionId: "expired-blocked-child",
    parentSessionId: "expired-blocked-parent",
    parentMessageId: "expired-blocked-message",
    description: "expired blocked task",
    prompt: "work",
    agent: "explore",
    status: "cancelled",
    startedAt: new Date(0),
    completedAt: new Date(0),
    blockedAt: new Date(0),
    blockedReason: "Need parent guidance",
    error: "Need parent guidance",
    ...overrides,
  }
}

function addTask(manager: BackgroundManager, task: BackgroundTask): ManagerInternals {
  const internals = unsafeTestValue<ManagerInternals>(manager)
  internals.tasks.set(task.id, task)
  return internals
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

describe("BackgroundManager blocked expiry notification", () => {
  test("#given a blocked task nobody answered #when the blocked expiry deadline passes #then the parent receives a terminal notification naming the unanswered park", async () => {
    // given
    jest.useFakeTimers()
    const manager = createManager()
    const task = createBlockedTask()
    const internals = addTask(manager, task)
    const captured: string[] = []
    const queuePendingParentWake = internals.parentWakeNotifier.queuePendingParentWake
    Reflect.set(internals.parentWakeNotifier, "queuePendingParentWake", (
      parentSessionID: string,
      notification: string,
      promptContext: unknown,
      shouldReply: boolean,
    ) => {
      captured.push(notification)
      queuePendingParentWake.call(internals.parentWakeNotifier, parentSessionID, notification, unsafeTestValue(promptContext), shouldReply)
    })
    await manager.notifyBlockedTask(task.id)
    captured.splice(0)

    // when
    jest.advanceTimersByTime(100)
    await flushAsyncWork()

    // then
    expect(captured.join("\n")).toContain("Blocked task expired unanswered")
  })

  test("#given a running blocked task with a running sibling #when the blocked expiry deadline passes #then its terminal notification keeps the sibling in progress", async () => {
    // given
    jest.useFakeTimers()
    const manager = createManager()
    const task = createBlockedTask({ status: "running", completedAt: undefined })
    const sibling = createBlockedTask({ id: "running-sibling", sessionId: "running-sibling-child", description: "running sibling", status: "running", completedAt: undefined, blockedAt: undefined, blockedReason: undefined })
    const internals = addTask(manager, task)
    addTask(manager, sibling)
    internals.pendingByParent.set(task.parentSessionId, new Set([task.id, sibling.id]))
    const captured: string[] = []
    const queuePendingParentWake = internals.parentWakeNotifier.queuePendingParentWake
    Reflect.set(internals.parentWakeNotifier, "queuePendingParentWake", (
      parentSessionID: string,
      notification: string,
      promptContext: unknown,
      shouldReply: boolean,
    ) => {
      captured.push(notification)
      queuePendingParentWake.call(internals.parentWakeNotifier, parentSessionID, notification, unsafeTestValue(promptContext), shouldReply)
    })
    // when
    internals.expireBlockedTask(task.id)
    await flushAsyncWork()

    // then
    const text = captured.join("\n")
    expect(text).toContain("**1 task still in progress.**")
    expect(text).not.toContain("**All other background tasks are complete.**")
  })

  test("#given a blocked task that is resumed before expiry #when the expiry timer would have fired #then no expiry notification is sent", async () => {
    // given
    jest.useFakeTimers()
    const manager = createManager()
    const task = createBlockedTask()
    const internals = addTask(manager, task)
    const captured: string[] = []
    const queuePendingParentWake = internals.parentWakeNotifier.queuePendingParentWake
    Reflect.set(internals.parentWakeNotifier, "queuePendingParentWake", (
      parentSessionID: string,
      notification: string,
      promptContext: unknown,
      shouldReply: boolean,
    ) => {
      captured.push(notification)
      queuePendingParentWake.call(internals.parentWakeNotifier, parentSessionID, notification, unsafeTestValue(promptContext), shouldReply)
    })
    await manager.notifyBlockedTask(task.id)
    captured.splice(0)

    // when
    await manager.resume({
      sessionId: task.sessionId ?? "",
      prompt: "parent answer",
      parentSessionId: task.parentSessionId,
      parentMessageId: task.parentMessageId,
    })
    captured.splice(0)
    jest.advanceTimersByTime(100)
    await flushAsyncWork()

    // then
    expect(captured).toHaveLength(0)
  })

  test("#given a blocked wake whose parent stayed busy past the active-defer ceiling #when the public flush surface runs #then the wake dispatches as a reply", async () => {
    // given
    const originalDateNow = Date.now
    let now = 100_000
    Date.now = () => now
    const promptAsyncCalls: Array<{ body: { noReply?: boolean } }> = []
    const manager = new BackgroundManager({
      pluginContext: unsafeTestValue<PluginInput>({
        client: {
          session: {
            abort: async () => ({ data: true }),
            messages: async () => ({ data: [
              { info: { role: "user", time: { created: 80_000 } }, parts: [{ type: "text", text: "start" }] },
              { info: { role: "assistant", finish: "stop", time: { created: 90_000 } }, parts: [{ type: "text", text: "safe" }] },
            ] }),
            status: async () => ({ data: { "expired-blocked-parent": { type: "busy" } } }),
            promptAsync: async (call: { body: { noReply?: boolean } }) => { promptAsyncCalls.push(call); return { data: {} } },
          },
        },
        directory: "/tmp/blocked-expiry-notification",
      }),
    })
    managers.push(manager)
    const internals = unsafeTestValue<ManagerInternals>(manager)
    const task = createBlockedTask()
    addTask(manager, task)
    await manager.notifyBlockedTask(task.id)
    const wake = internals.parentWakeNotifier.getPendingParentWakes().get(task.parentSessionId)
    if (!wake) throw new Error("expected blocked wake")
    wake.queuedAt = now - 60_000

    try {
      // when
      await internals.parentWakeNotifier.flushPendingParentWake(task.parentSessionId)

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).not.toBe(true)
    } finally {
      Date.now = originalDateNow
    }
  })

  test("#given an expiry notification with no completionReason #when building the notification #then no reason qualifier is rendered", async () => {
    // given
    jest.useFakeTimers()
    const manager = createManager()
    const task = createBlockedTask({ completionReason: undefined })
    const internals = addTask(manager, task)
    await manager.notifyBlockedTask(task.id)

    // when
    jest.advanceTimersByTime(100)
    await flushAsyncWork()

    // then
    const text = [...internals.parentWakeNotifier.getPendingParentWakes().values()].map((wake) => wake.notification).join("\n")
    expect(text).not.toContain("reason:")
  })
})
