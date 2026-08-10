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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function blockedManager(session: Record<string, unknown>, directory: string): BackgroundManager {
  const value = new BackgroundManager({
    pluginContext: { client: { session }, directory: `/tmp/${directory}` } as PluginInput,
    config: { blockedRewakeMs: 60_000, blockedExpiryMs: 60 },
  } as never)
  managers.push(value)
  return value
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
  test("#given an accepted resume still in flight #when the expiry deadline passes #then the answer wins and the task is not expired", async () => {
    // given
    const value = blockedManager(
      { promptAsync: async () => { await sleep(300); return {} }, abort: async () => ({}) },
      "race-inflight",
    )
    const backgroundTask = task({
      id: "race-inflight", sessionId: "race-inflight-child", status: "cancelled",
      blockedAt: new Date(), blockedReason: "Need parent input", completedAt: new Date(),
      error: "Need parent input", concurrencyGroup: "explore",
    })
    addTask(value, backgroundTask)
    await value.notifyBlockedTask(backgroundTask.id)

    // when
    const resuming = value.resume({ sessionId: "race-inflight-child", prompt: "answer", parentSessionId: "race-parent", parentMessageId: "answer-message" })
    await sleep(150)
    const inFlightDuringExpiry = (Reflect.get(value, "resumingBlockedTaskIds") as Set<string>).has(backgroundTask.id)
    await resuming
    await sleep(400)

    // then
    expect(inFlightDuringExpiry).toBe(true)
    expect(backgroundTask.status).toBe("running")
    expect(backgroundTask.blockedAt).toBeUndefined()
    expect(backgroundTask.error).toBeUndefined()
    expect((Reflect.get(value, "resumingBlockedTaskIds") as Set<string>).size).toBe(0)
  })

  test("#given a blocked task nobody answers #when the expiry deadline passes #then expiry wins and the deferral is not a permanent leak", async () => {
    // given
    const value = blockedManager({ promptAsync: async () => ({}), abort: async () => ({}) }, "race-unanswered")
    const backgroundTask = task({
      id: "race-unanswered", sessionId: "race-unanswered-child", status: "cancelled",
      blockedAt: new Date(), blockedReason: "Need parent input", completedAt: new Date(),
      error: "Need parent input", concurrencyGroup: "explore",
    })
    addTask(value, backgroundTask)

    // when
    await value.notifyBlockedTask(backgroundTask.id)
    await sleep(300)

    // then
    expect(backgroundTask.status).toBe("cancelled")
    expect(backgroundTask.error).toContain("expired unanswered")
    expect((Reflect.get(value, "resumingBlockedTaskIds") as Set<string>).size).toBe(0)
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
