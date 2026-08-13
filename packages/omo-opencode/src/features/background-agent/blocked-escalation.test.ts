import { afterEach, describe, expect, jest, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { dispatchInternalPrompt, releaseAllPromptAsyncReservationsForTesting } from "../../shared/prompt-async-gate"
import { buildBackgroundTaskNotificationText } from "./background-task-notification-template"
import {
  BlockedEscalation,
  buildBlockedReminderNotification,
} from "./blocked-escalation"
import { DEFAULT_BLOCKED_EXPIRY_MS, DEFAULT_BLOCKED_REWAKE_MS, TERMINAL_TASK_TTL_MS } from "./constants"
import { BackgroundManager } from "./manager"
import {
  isFailureParentWake,
  isRedundantParentWake,
  mergeParentWakeNotifications,
} from "./parent-wake-dedupe"
import type { BackgroundTask } from "./types"

const managers: BackgroundManager[] = []

function createTask(sessionId = "blocked-child"): BackgroundTask {
  return {
    id: `task-${sessionId}`,
    sessionId,
    parentSessionId: "blocked-parent",
    parentMessageId: "parent-message",
    description: "blocked task",
    prompt: "work",
    agent: "explore",
    status: "cancelled",
    startedAt: new Date(),
    completedAt: new Date(),
    blockedAt: new Date(),
    blockedReason: "Need parent input",
    error: "Need parent input",
    concurrencyGroup: "explore",
  }
}

function createManager(session: Record<string, unknown>): BackgroundManager {
  const manager = new BackgroundManager({
    pluginContext: { client: { session }, directory: "/tmp/blocked-escalation-test" } as PluginInput,
  })
  managers.push(manager)
  return manager
}

function addTask(manager: BackgroundManager, task: BackgroundTask): void {
  const tasks = Reflect.get(manager, "tasks")
  if (!(tasks instanceof Map)) throw new Error("BackgroundManager tasks map unavailable")
  tasks.set(task.id, task)
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

async function resume(manager: BackgroundManager, task: BackgroundTask): Promise<void> {
  await manager.resume({
    sessionId: task.sessionId ?? "",
    prompt: "parent answer",
    parentSessionId: task.parentSessionId,
    parentMessageId: task.parentMessageId,
  })
  await flushAsyncWork()
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown()
  releaseAllPromptAsyncReservationsForTesting()
  jest.useRealTimers()
})

describe("BlockedEscalation defaults", () => {
  test("#given the shipped escalation defaults #when they are read #then the reminder is 10m and hard expiry is 20m, ordered and inside the terminal TTL", () => {
    // given
    // The live-harness QA that proves these timers shortens both knobs, so the
    // real shipped values are only ever asserted here.

    // when
    const rewakeMinutes = DEFAULT_BLOCKED_REWAKE_MS / 60_000
    const expiryMinutes = DEFAULT_BLOCKED_EXPIRY_MS / 60_000

    // then
    expect(rewakeMinutes).toBe(10)
    expect(expiryMinutes).toBe(20)
    expect(DEFAULT_BLOCKED_REWAKE_MS).toBeLessThan(DEFAULT_BLOCKED_EXPIRY_MS)
    expect(DEFAULT_BLOCKED_EXPIRY_MS).toBeLessThan(TERMINAL_TASK_TTL_MS)
  })
})

describe("BlockedEscalation", () => {
  test("#given an unanswered block #when time passes beyond both deadlines #then exactly one reminder fires before expiry", async () => {
    // given
    jest.useFakeTimers()
    const reminders: string[] = []
    let expiries = 0
    const escalation = new BlockedEscalation({
      rewakeMs: DEFAULT_BLOCKED_REWAKE_MS,
      expiryMs: DEFAULT_BLOCKED_EXPIRY_MS,
      onReminder: async (taskId) => { reminders.push(taskId) },
      onExpiry: (taskId) => { expiries += taskId === "task-1" ? 1 : 0 },
    })
    escalation.arm("task-1")

    // when
    jest.advanceTimersByTime(DEFAULT_BLOCKED_EXPIRY_MS * 2)

    // then
    expect(reminders).toEqual(["task-1"])
    expect(expiries).toBe(1)
  })

  test("#given an unanswered blocked task #when hard expiry fires #then blocked fields clear and error records unanswered expiry", async () => {
    // given
    jest.useFakeTimers()
    const manager = createManager({ promptAsync: async () => ({}), abort: async () => ({}) })
    const task = createTask()
    addTask(manager, task)
    await manager.notifyBlockedTask(task.id)

    // when
    jest.advanceTimersByTime(DEFAULT_BLOCKED_EXPIRY_MS)

    // then
    expect(task.status).toBe("cancelled")
    expect(task.blockedAt).toBeUndefined()
    expect(task.blockedReason).toBeUndefined()
    expect(task.error).toContain("expired unanswered")
  })

  test("#given a park whose abort failed so the child still runs #when hard expiry fires #then the child session is aborted rather than orphaned", async () => {
    // given
    jest.useFakeTimers()
    const abortedSessions: string[] = []
    const manager = createManager({
      promptAsync: async () => ({}),
      abort: async ({ path }: { path: { id: string } }) => {
        abortedSessions.push(path.id)
        return {}
      },
    })
    const task = createTask("orphan-child")
    task.status = "running"
    task.completedAt = undefined
    addTask(manager, task)
    await manager.notifyBlockedTask(task.id)

    // when
    jest.advanceTimersByTime(DEFAULT_BLOCKED_EXPIRY_MS)
    await flushAsyncWork()

    // then
    expect(task.status).toBe("cancelled")
    expect(abortedSessions).toEqual(["orphan-child"])
  })

  test("#given a blocked task #when accepted resume answers it #then both escalation timers are cancelled", async () => {
    // given
    jest.useFakeTimers()
    const manager = createManager({ promptAsync: async () => ({}), abort: async () => ({}) })
    const task = createTask("accepted")
    addTask(manager, task)
    await manager.notifyBlockedTask(task.id)

    // when
    await resume(manager, task)
    Reflect.get(manager, "stopPolling").call(manager)
    jest.advanceTimersByTime(DEFAULT_BLOCKED_EXPIRY_MS * 2)

    // then
    expect(task.status).toBe("running")
    expect(task.blockedAt).toBeUndefined()
    expect(task.error).toBeUndefined()
  })

  test("#given a blocked task #when resume is queued or skipped #then escalation remains armed", async () => {
    // given
    jest.useFakeTimers()
    const queuedClient = { session: { promptAsync: async () => ({}), abort: async () => ({}) } }
    await dispatchInternalPrompt({
      mode: "async",
      client: queuedClient,
      sessionID: "queued",
      source: "blocked-escalation-test",
      settleMs: 0,
      postDispatchHoldMs: 1_000,
      input: { path: { id: "queued" }, body: { parts: [] } },
    })
    const queuedManager = createManager(queuedClient.session)
    const queuedTask = createTask("queued")
    addTask(queuedManager, queuedTask)
    await queuedManager.notifyBlockedTask(queuedTask.id)
    const skippedManager = createManager({
      status: async () => ({ data: { skipped: { type: "busy" } } }),
      promptAsync: async () => ({}),
      abort: async () => ({}),
    })
    const skippedTask = createTask("skipped")
    addTask(skippedManager, skippedTask)
    await skippedManager.notifyBlockedTask(skippedTask.id)

    // when
    await resume(queuedManager, queuedTask)
    await resume(skippedManager, skippedTask)
    jest.advanceTimersByTime(DEFAULT_BLOCKED_EXPIRY_MS)

    // then
    expect(queuedTask.error).toContain("expired unanswered")
    expect(skippedTask.error).toContain("expired unanswered")
  })

  test("#given first and reminder blocked wakes #when dedupe and final merging run #then reminder remains distinct and actionable in both orderings", () => {
    // given
    const task = createTask()
    const first = buildBackgroundTaskNotificationText({
      task,
      duration: "1m",
      statusText: "BLOCKED",
      allComplete: false,
      remainingCount: 1,
      completedTasks: [],
    })
    const reminder = buildBlockedReminderNotification(first, DEFAULT_BLOCKED_REWAKE_MS)
    const firstWake = { promptContext: {}, notifications: [first], shouldReply: true }
    const reminderWake = { promptContext: {}, notifications: [reminder], shouldReply: true }
    const final = "<system-reminder>\n[BACKGROUND TASK COMPLETED]\n[ALL BACKGROUND TASKS COMPLETE]\n</system-reminder>"

    // when
    const reminderAfterFinal = mergeParentWakeNotifications([final], reminder)
    const finalAfterReminder = mergeParentWakeNotifications([reminder], final)

    // then
    expect(reminder).not.toBe(first)
    expect(reminder).toContain("[BACKGROUND TASK BLOCKED] (reminder 1 of 1, waiting 10m)")
    expect(isRedundantParentWake(reminderWake, firstWake)).toBe(false)
    expect(isFailureParentWake(reminderWake)).toBe(true)
    expect(reminderAfterFinal).toEqual([final, reminder])
    expect(finalAfterReminder).toEqual([final, reminder])
  })

  test("#given hard expiry already fired #when more time passes #then no later reminder fires", async () => {
    // given
    jest.useFakeTimers()
    const reminders: string[] = []
    const escalation = new BlockedEscalation({
      rewakeMs: DEFAULT_BLOCKED_EXPIRY_MS + 1,
      expiryMs: DEFAULT_BLOCKED_EXPIRY_MS,
      onReminder: async (taskId) => { reminders.push(taskId) },
      onExpiry: () => {},
    })
    escalation.arm("task-1")

    // when
    jest.advanceTimersByTime(DEFAULT_BLOCKED_EXPIRY_MS * 2)

    // then
    expect(reminders).toEqual([])
  })
})
