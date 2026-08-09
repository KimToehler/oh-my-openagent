import { afterEach, describe, expect, jest, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { releaseAllPromptAsyncReservationsForTesting } from "../../shared/prompt-async-gate"
import { createReportBlockedTool, type ReportBlockedManager } from "../../tools/report-blocked/tools"
import { BackgroundManager } from "./manager"
import { mergeParentWakeNotifications } from "./parent-wake-dedupe"
import { checkAndInterruptStaleTasks } from "./task-poller"
import type { BackgroundTask } from "./types"

const managers: BackgroundManager[] = []

function task(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "race-task", sessionId: "race-child", parentSessionId: "race-parent", parentMessageId: "message",
    description: "race", prompt: "work", agent: "explore", status: "running",
    startedAt: new Date(0), progress: { toolCalls: 0, lastUpdate: new Date(0) }, ...overrides,
  }
}

function manager(session: Record<string, unknown>): BackgroundManager {
  const value = new BackgroundManager({ pluginContext: { client: { session }, directory: "/tmp/blocked-races" } as PluginInput })
  managers.push(value)
  return value
}

function addTask(value: BackgroundManager, backgroundTask: BackgroundTask): void {
  const tasks = Reflect.get(value, "tasks")
  if (!(tasks instanceof Map)) throw new Error("BackgroundManager tasks map unavailable")
  tasks.set(backgroundTask.id, backgroundTask)
}

async function flush(): Promise<void> { for (let index = 0; index < 12; index += 1) await Promise.resolve() }

afterEach(() => {
  for (const value of managers.splice(0)) value.shutdown()
  releaseAllPromptAsyncReservationsForTesting()
  jest.useRealTimers()
})

describe("blocked task concurrency races", () => {
  test("#given accepted answer and due expiry #when both claim one block #then answer wins with one distinct parent notification", async () => {
    // given
    jest.useFakeTimers()
    const notifications: string[] = []
    const value = manager({ promptAsync: async () => ({}), abort: async () => ({}) })
    const backgroundTask = task({ status: "cancelled", blockedAt: new Date(), blockedReason: "Need parent input", completedAt: new Date(), concurrencyGroup: "explore" })
    addTask(value, backgroundTask)
    Reflect.set(value, "enqueueNotificationForParent", async (_parent: string, notify: () => Promise<void>) => notify())
    Reflect.set(value, "notifyParentSession", async (_task: BackgroundTask, transform?: (text: string) => string) => {
      notifications.push(transform?.("[BACKGROUND TASK BLOCKED]") ?? "[BACKGROUND TASK ANSWER ACCEPTED]")
    })
    await value.notifyBlockedTask(backgroundTask.id)
    notifications.length = 0

    // when
    await value.resume({ sessionId: "race-child", prompt: "answer", parentSessionId: "race-parent", parentMessageId: "answer-message" })
    await flush()
    jest.runOnlyPendingTimers()

    // then
    expect(backgroundTask.status).toBe("running")
    expect(notifications.filter((text) => text.includes("ANSWER ACCEPTED"))).toHaveLength(1)
    expect(mergeParentWakeNotifications([notifications[0] ?? ""], notifications[1] ?? "")).toHaveLength(2)
  })

  test("#given self-cancel and stale poller interrupt #when abort overlaps #then one cancellation wins and one parent notification dispatches", async () => {
    // given
    let releaseAbort: (() => void) | undefined
    const abortGate = new Promise<void>((resolve) => { releaseAbort = resolve })
    let aborts = 0
    const notifications: string[] = []
    const backgroundTask = task()
    const value = manager({ abort: async () => { aborts += 1; await abortGate; return { data: true } } })
    addTask(value, backgroundTask)
    Reflect.set(value, "enqueueNotificationForParent", async (_parent: string, notify: () => Promise<void>) => notify())
    Reflect.set(value, "notifyParentSession", async (current: BackgroundTask) => { notifications.push(current.error ?? current.status) })

    // when
    const selfCancel = value.cancelTask(backgroundTask.id, { source: "child", reason: "child self-cancelled" })
    const poller = checkAndInterruptStaleTasks({
      tasks: [backgroundTask], client: { session: { abort: async () => { aborts += 1; return { data: true } } } } as PluginInput["client"],
      config: { staleTimeoutMs: 0 }, concurrencyManager: Reflect.get(value, "concurrencyManager"),
      notifyParentSession: async (current) => { notifications.push(current.error ?? current.status) },
      claimTaskInterruption: (taskId) => {
        const claims = Reflect.get(value, "completingTaskIds") as Set<string>
        if (claims.has(taskId)) return false
        claims.add(taskId)
        return true
      },
      releaseTaskInterruption: (taskId) => { (Reflect.get(value, "completingTaskIds") as Set<string>).delete(taskId) },
    })
    releaseAbort?.()
    await Promise.all([selfCancel, poller])

    // then
    expect(aborts).toBe(1)
    expect(notifications).toHaveLength(1)
  })

  test("#given poller owns stale cancellation #when child self-cancel follows #then poller alone cancels and notifies", async () => {
    // given
    const notifications: string[] = []
    const backgroundTask = task()
    const value = manager({ abort: async () => ({ data: true }) })
    addTask(value, backgroundTask)

    // when
    await checkAndInterruptStaleTasks({
      tasks: [backgroundTask], client: { session: { abort: async () => ({ data: true }) } } as PluginInput["client"],
      config: { staleTimeoutMs: 0 }, concurrencyManager: Reflect.get(value, "concurrencyManager"),
      notifyParentSession: async (current) => { notifications.push(current.error ?? current.status) },
    })
    const selfCancelled = await value.cancelTask(backgroundTask.id, { source: "child" })

    // then
    expect(selfCancelled).toBe(false)
    expect(notifications).toHaveLength(1)
  })

  test("#given three prior parks #when report_blocked runs a fourth time #then task fails with recurring-block error instead of parking", async () => {
    // given
    const backgroundTask = task({ blockedParkCount: 3 })
    const calls: string[] = []
    const fake: ReportBlockedManager = {
      findBySession: () => backgroundTask,
      notifyBlockedTask: async () => { calls.push("notify") },
      cancelTask: async () => { calls.push("park"); return true },
      failBlockedTask: async (_id, reason) => { calls.push("fail"); backgroundTask.status = "error"; backgroundTask.error = reason; return true },
    }
    const tool = createReportBlockedTool(fake)

    // when
    const result = await tool.execute({ reason: "same timeout", needs: "parent answer" }, { sessionID: "race-child" } as never)

    // then
    expect(backgroundTask.status).toBe("error")
    expect(backgroundTask.error).toContain("Recurring blocked state")
    expect(calls).toEqual(["fail"])
    expect(result).toContain("failed after 3 prior park attempts")
  })
})
