import { tmpdir } from "node:os"
import type { PluginInput } from "@opencode-ai/plugin"
import { afterEach, describe, expect, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { createReportBlockedTool } from "../../tools/report-blocked/tools"
import { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"

type NotificationInternals = {
  readonly parentWakeNotifier: {
    readonly hasNotificationPreparation: (sessionID: string) => boolean
  }
  readonly tasks: Map<string, BackgroundTask>
}

const managersToShutdown: BackgroundManager[] = []

afterEach(() => {
  while (managersToShutdown.length > 0) {
    managersToShutdown.pop()?.shutdown()
  }
})

function createManager(): BackgroundManager {
  const directory = tmpdir()
  const pluginContext = unsafeTestValue<PluginInput>({
    client: {
      session: {
        abort: async () => ({ data: true }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
    },
    directory,
  })
  const manager = new BackgroundManager({ pluginContext, enableParentSessionNotifications: false })
  managersToShutdown.push(manager)
  return manager
}

function createBlockedTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "blocked-task",
    sessionId: "blocked-child-session",
    parentSessionId: "blocked-parent-session",
    parentMessageId: "parent-message",
    description: "blocked task",
    prompt: "perform blocked work",
    agent: "test-agent",
    status: "running",
    startedAt: new Date("2026-08-09T00:00:00.000Z"),
    blockedAt: new Date("2026-08-09T00:01:00.000Z"),
    blockedReason: "MCP timed out; needs parent guidance",
    error: "MCP timed out; needs parent guidance",
    ...overrides,
  }
}

function addTask(manager: BackgroundManager, task: BackgroundTask): NotificationInternals {
  const internals = unsafeTestValue<NotificationInternals>(manager)
  internals.tasks.set(task.id, task)
  return internals
}

describe("BackgroundManager blocked task notification", () => {
  test("#given a task with blocked metadata #when notifyBlockedTask runs #then one wake targets its parent session", async () => {
    // given
    const manager = createManager()
    const task = createBlockedTask()
    addTask(manager, task)
    const parentSessionIDs: string[] = []
    Reflect.set(manager, "enqueueNotificationForParent", async (parentSessionID: string, operation: () => Promise<void>) => {
      parentSessionIDs.push(parentSessionID)
      await operation()
    })

    // when
    await manager.notifyBlockedTask(task.id)

    // then
    expect(parentSessionIDs).toEqual([task.parentSessionId])
    expect(manager.getPendingNotifications(task.parentSessionId)).toEqual([task])
  })

  test("#given one blocked task #when notifyBlockedTask runs twice #then only one wake is dispatched", async () => {
    // given
    const manager = createManager()
    const task = createBlockedTask()
    addTask(manager, task)
    let wakeCount = 0
    Reflect.set(manager, "enqueueNotificationForParent", async (_parentSessionID: string, operation: () => Promise<void>) => {
      wakeCount += 1
      await operation()
    })

    // when
    await manager.notifyBlockedTask(task.id)
    await manager.notifyBlockedTask(task.id)

    // then
    expect(wakeCount).toBe(1)
    expect(manager.getPendingNotifications(task.parentSessionId)).toHaveLength(1)
  })

  test("#given one blocked episode #when notifyBlockedTask runs twice #then within-episode dedupe emits one wake", async () => {
    // given
    const manager = createManager()
    const task = createBlockedTask()
    addTask(manager, task)
    let wakeCount = 0
    Reflect.set(manager, "enqueueNotificationForParent", async (_parentSessionID: string, operation: () => Promise<void>) => {
      wakeCount += 1
      await operation()
    })

    // when
    await manager.notifyBlockedTask(task.id)
    await manager.notifyBlockedTask(task.id)

    // then
    expect(wakeCount).toBe(1)
  })

  test("#given a blocked wake #when notifyParentSession queues it #then the parent is asked to reply", async () => {
    // given
    const manager = createManager()
    const task = createBlockedTask()
    const internals = addTask(manager, task)
    Reflect.set(manager, "enableParentSessionNotifications", true)
    Reflect.set(manager, "isSessionActive", async () => true)

    // when
    await Reflect.get(manager, "notifyParentSession").call(manager, task)

    // then
    expect(internals.parentWakeNotifier.getPendingParentWakes().get(task.parentSessionId)?.shouldReply).toBe(true)
  })

  test("#given a notifying cancel #when cancelTask flips the task terminal #then notification preparation covers the terminal-to-wake window", async () => {
    // given
    const manager = createManager()
    const task = createBlockedTask()
    const internals = addTask(manager, task)
    let observedActive = true
    let observedPendingWake = false
    Reflect.set(manager, "enqueueNotificationForParent", async (parentSessionID: string, operation: () => Promise<void>) => {
      observedActive = task.status === "running" || task.status === "pending"
      observedPendingWake = internals.parentWakeNotifier.hasNotificationPreparation(parentSessionID)
      await operation()
    })

    // when
    const cancelled = await manager.cancelTask(task.id, { abortSession: false, reason: task.blockedReason })

    // then
    expect(cancelled).toBe(true)
    expect(observedActive).toBe(false)
    expect(observedPendingWake).toBe(true)
  })

  test("#given the real report_blocked tool over a real manager #when the child parks #then the wake is queued while the task is still active", async () => {
    // given
    const manager = createManager()
    const task = createBlockedTask({ status: "running", completedAt: undefined, blockedAt: undefined, blockedReason: undefined })
    addTask(manager, task)
    const observedStatusAtWake: string[] = []
    Reflect.set(manager, "enqueueNotificationForParent", async (_parentSessionID: string, operation: () => Promise<void>) => {
      observedStatusAtWake.push(task.status)
      await operation()
    })
    const reportBlocked = createReportBlockedTool(manager)

    // when
    const result = await reportBlocked.execute(
      { reason: "Provider requests time out", needs: "Choose another provider" },
      unsafeTestValue({ sessionID: task.sessionId, messageID: "msg", agent: "sisyphus-junior", abort: new AbortController().signal }),
    )

    // then
    expect(result).toContain("parked")
    expect(observedStatusAtWake).toEqual(["running"])
    expect(task.status).toBe("cancelled")
  })

  test("#given the real report_blocked tool over a real manager #when the park skips notification #then no wake-preparation slot is left reserved", async () => {
    // given
    const manager = createManager()
    const task = createBlockedTask({ status: "running", completedAt: undefined, blockedAt: undefined, blockedReason: undefined })
    const internals = addTask(manager, task)
    Reflect.set(manager, "enqueueNotificationForParent", async (_parentSessionID: string, operation: () => Promise<void>) => {
      await operation()
    })
    const reportBlocked = createReportBlockedTool(manager)

    // when
    await reportBlocked.execute(
      { reason: "Provider requests time out", needs: "Choose another provider" },
      unsafeTestValue({ sessionID: task.sessionId, messageID: "msg", agent: "sisyphus-junior", abort: new AbortController().signal }),
    )

    // then
    expect(internals.parentWakeNotifier.hasNotificationPreparation(task.parentSessionId)).toBe(false)
  })

  test("#given a blocked reason in task.error #when notifyBlockedTask runs #then notification rendering receives that error", async () => {
    // given
    const manager = createManager()
    const task = createBlockedTask({ error: "Parent must refresh expired credentials" })
    addTask(manager, task)
    const renderedErrors: Array<string | undefined> = []
    Reflect.set(manager, "notifyParentSession", async (notifiedTask: BackgroundTask) => {
      renderedErrors.push(notifiedTask.error)
    })

    // when
    await manager.notifyBlockedTask(task.id)

    // then
    expect(renderedErrors).toEqual(["Parent must refresh expired credentials"])
  })
})
