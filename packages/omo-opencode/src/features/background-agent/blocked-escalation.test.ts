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

  test("#given a park whose abort failed so the task kept its slot #when hard expiry fires #then the concurrency slot and descendant count are reclaimed", async () => {
    // given
    jest.useFakeTimers()
    const manager = createManager({ promptAsync: async () => ({}), abort: async () => ({}) })
    const task = createTask("leak-child")
    task.status = "running"
    task.completedAt = undefined
    task.concurrencyKey = "explore"
    task.rootSessionId = "root-session"
    addTask(manager, task)
    const concurrencyManager = Reflect.get(manager, "concurrencyManager")
    await concurrencyManager.acquire("explore", task.id)
    const rootDescendantCounts = Reflect.get(manager, "rootDescendantCounts")
    rootDescendantCounts.set("root-session", 1)
    await manager.notifyBlockedTask(task.id)

    // when
    jest.advanceTimersByTime(DEFAULT_BLOCKED_EXPIRY_MS)
    await flushAsyncWork()

    // then
    const counts = Reflect.get(concurrencyManager, "counts")
    expect(counts.get(concurrencyManager.getConcurrencyKey("explore")) ?? 0).toBe(0)
    expect(rootDescendantCounts.has("root-session")).toBe(false)
    expect(task.concurrencyKey).toBeUndefined()
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

  test("#given a blocked task #when cancellation completes before reminder time #then no blocked reminder is emitted", async () => {
    // given
    jest.useFakeTimers()
    const manager = createManager({ promptAsync: async () => ({}), abort: async () => ({}) })
    let reminders = 0
    Reflect.set(manager, "notifyBlockedReminder", async () => { reminders += 1 })
    const task = createTask("cancelled-before-reminder")
    task.status = "running"
    task.completedAt = undefined
    addTask(manager, task)
    await manager.notifyBlockedTask(task.id)

    // when
    await manager.cancelTask(task.id, { abortSession: false, skipNotification: true })
    jest.advanceTimersByTime(DEFAULT_BLOCKED_REWAKE_MS)
    await flushAsyncWork()

    // then
    expect(reminders).toBe(0)
  })

  test("#given a blocked task #when report_blocked parks it via cancelTask #then escalation stays armed and the reminder still fires", async () => {
    // given
    // A park IS a cancellation: report_blocked sets blockedAt, arms escalation, then
    // calls cancelTask with source "report_blocked". Terminal-cancel cleanup must not
    // run on that path, or the park disarms the timers it just armed.
    jest.useFakeTimers()
    const manager = createManager({ promptAsync: async () => ({}), abort: async () => ({}) })
    let reminders = 0
    Reflect.set(manager, "notifyBlockedReminder", async () => { reminders += 1 })
    const task = createTask("parked-via-report-blocked")
    task.status = "running"
    task.completedAt = undefined
    addTask(manager, task)
    await manager.notifyBlockedTask(task.id)

    // when
    await manager.cancelTask(task.id, { source: "report_blocked", abortSession: false, skipNotification: true })
    jest.advanceTimersByTime(DEFAULT_BLOCKED_REWAKE_MS)
    await flushAsyncWork()

    // then
    expect(task.blockedAt).toBeDefined()
    expect(reminders).toBe(1)
  })

  test("#given a task parked by report_blocked #when it is later cancelled #then the reminder stops", async () => {
    // given
    // The reported incident. A park leaves status "cancelled" with blockedAt set, so the
    // retiring cancel hits cancelTask's early return, NOT its main path. createTask already
    // produces that parked shape; forcing status to "running" first (as an earlier version
    // of this test did) constructs a state the park path never produces and passes against
    // a live defect.
    jest.useFakeTimers()
    const manager = createManager({ promptAsync: async () => ({}), abort: async () => ({}) })
    let reminders = 0
    Reflect.set(manager, "notifyBlockedReminder", async () => { reminders += 1 })
    const task = createTask("parked-then-cancelled")
    addTask(manager, task)
    await manager.notifyBlockedTask(task.id)
    expect(task.status).toBe("cancelled")
    expect(task.blockedAt).toBeDefined()

    // when
    await manager.cancelTask(task.id, { source: "background_cancel", abortSession: false, skipNotification: true })
    jest.advanceTimersByTime(DEFAULT_BLOCKED_REWAKE_MS)
    await flushAsyncWork()

    // then
    expect(task.blockedAt).toBeUndefined()
    expect(task.blockedReason).toBeUndefined()
    expect(reminders).toBe(0)
  })

  test("#given a task parked by report_blocked #when the park itself re-enters cancelTask #then escalation stays armed", async () => {
    // given
    // The park calls cancelTask on an already-cancelled task in the recurring-park path.
    // That re-entry must not disarm the timers the park just armed.
    jest.useFakeTimers()
    const manager = createManager({ promptAsync: async () => ({}), abort: async () => ({}) })
    let reminders = 0
    Reflect.set(manager, "notifyBlockedReminder", async () => { reminders += 1 })
    const task = createTask("parked-reentrant")
    addTask(manager, task)
    await manager.notifyBlockedTask(task.id)

    // when
    await manager.cancelTask(task.id, { source: "report_blocked", abortSession: false, skipNotification: true })
    jest.advanceTimersByTime(DEFAULT_BLOCKED_REWAKE_MS)
    await flushAsyncWork()

    // then
    expect(task.blockedAt).toBeDefined()
    expect(reminders).toBe(1)
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

  // Guards the interaction between the queued-resume rollback and the expiry abort:
  // restoreTaskAfterSkippedResume puts the task back to its pre-resume terminal
  // status, so wasRunning is false at expiry and no abort fires. If that rollback
  // ever stops restoring status, expiry would start aborting a child whose answer is
  // still queued for delivery, destroying work the parent already committed to.
  test("#given a resume the dispatcher queued #when expiry fires #then the rollback leaves the task terminal so no abort is issued", async () => {
    // given
    jest.useFakeTimers()
    const abortedSessions: string[] = []
    const queuedClient = {
      session: {
        promptAsync: async () => ({}),
        abort: async ({ path }: { path: { id: string } }) => {
          abortedSessions.push(path.id)
          return {}
        },
      },
    }
    await dispatchInternalPrompt({
      mode: "async",
      client: queuedClient,
      sessionID: "queued-abort",
      source: "blocked-escalation-test",
      settleMs: 0,
      postDispatchHoldMs: 1_000,
      input: { path: { id: "queued-abort" }, body: { parts: [] } },
    })
    const manager = createManager(queuedClient.session)
    const task = createTask("queued-abort")
    addTask(manager, task)
    await manager.notifyBlockedTask(task.id)

    // when
    await resume(manager, task)
    jest.advanceTimersByTime(DEFAULT_BLOCKED_EXPIRY_MS)
    await flushAsyncWork()

    // then
    expect(abortedSessions).toEqual([])
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
