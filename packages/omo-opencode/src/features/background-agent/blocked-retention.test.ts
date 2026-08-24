import { tmpdir } from "node:os"
import { afterEach, describe, expect, jest, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import {
  DEFAULT_BLOCKED_EXPIRY_MS,
  TASK_CLEANUP_DELAY_MS,
  TERMINAL_TASK_TTL_MS,
} from "./constants"
import { BackgroundManager } from "./manager"
import { clearBackgroundTaskRegistryForTesting, getRegisteredBackgroundTask } from "./task-registry"
import { pruneStaleTasksAndNotifications } from "./task-poller"
import type { BackgroundTask } from "./types"

const originalDateNow = Date.now
let managerUnderTest: BackgroundManager | undefined
let currentTime = new Date("2026-08-09T00:00:00.000Z").getTime()

afterEach(() => {
  managerUnderTest?.shutdown()
  managerUnderTest = undefined
  clearBackgroundTaskRegistryForTesting()
  jest.useRealTimers()
  Date.now = originalDateNow
  currentTime = new Date("2026-08-09T00:00:00.000Z").getTime()
})

function createTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "task-blocked",
    sessionId: "session-blocked",
    parentSessionId: "session-parent",
    parentMessageId: "message-parent",
    description: "blocked task",
    prompt: "wait for parent answer",
    agent: "test-agent",
    status: "cancelled",
    startedAt: new Date(currentTime - 1_000),
    completedAt: new Date(currentTime),
    ...overrides,
  }
}

function createManager(): BackgroundManager {
  const client = {
    session: {
      messages: async () => [],
      status: async () => ({ data: {} }),
      prompt: async () => ({}),
      promptAsync: async () => ({}),
      abort: async () => ({}),
    },
  }
  const pluginContext: PluginInput = {
    client: client as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory: tmpdir(),
    worktree: tmpdir(),
    serverUrl: new URL("http://localhost"),
    $: {} as PluginInput["$"],
  }

  return new BackgroundManager({ pluginContext, config: undefined })
}

function addTask(manager: BackgroundManager, task: BackgroundTask): void {
  const tasks = Reflect.get(manager, "tasks") as Map<string, BackgroundTask>
  tasks.set(task.id, task)
}

function scheduleRemoval(manager: BackgroundManager, taskId: string): void {
  const scheduleTaskRemoval = Reflect.get(manager, "scheduleTaskRemoval") as (id: string) => void
  scheduleTaskRemoval.call(manager, taskId)
}

function prune(tasks: Map<string, BackgroundTask>): void {
  pruneStaleTasksAndNotifications({
    tasks,
    notifications: new Map(),
    onTaskPruned: () => {},
  })
}

describe("blocked task retention", () => {
  describe("#given manager cleanup is scheduled", () => {
    test("#then keeps a blocked task after the normal cleanup delay", async () => {
      // given
      jest.useFakeTimers()
      Date.now = () => currentTime
      managerUnderTest = createManager()
      const task = createTask({ blockedAt: new Date(currentTime), blockedReason: "Need input" })
      addTask(managerUnderTest, task)
      scheduleRemoval(managerUnderTest, task.id)

      // when
      currentTime += TASK_CLEANUP_DELAY_MS + 1
      jest.advanceTimersByTime(TASK_CLEANUP_DELAY_MS + 1)

      // then
      expect(managerUnderTest.findBySession(task.sessionId ?? "")).toBe(task)
    })

    test("#then removes a blocked task after hard expiry", async () => {
      // given
      jest.useFakeTimers()
      Date.now = () => currentTime
      managerUnderTest = createManager()
      const task = createTask({ blockedAt: new Date(currentTime), blockedReason: "Need input" })
      addTask(managerUnderTest, task)
      scheduleRemoval(managerUnderTest, task.id)

      // when
      currentTime += DEFAULT_BLOCKED_EXPIRY_MS + TASK_CLEANUP_DELAY_MS + 1
      jest.advanceTimersByTime(DEFAULT_BLOCKED_EXPIRY_MS + TASK_CLEANUP_DELAY_MS + 1)

      // then
      expect(managerUnderTest.findBySession(task.sessionId ?? "")).toBeUndefined()
    })

    test("#then removes an ordinary cancelled task on the normal schedule", async () => {
      // given
      jest.useFakeTimers()
      Date.now = () => currentTime
      managerUnderTest = createManager()
      const task = createTask()
      addTask(managerUnderTest, task)
      scheduleRemoval(managerUnderTest, task.id)

      // when
      currentTime += TASK_CLEANUP_DELAY_MS + 1
      jest.advanceTimersByTime(TASK_CLEANUP_DELAY_MS + 1)

      // then
      expect(managerUnderTest.findBySession(task.sessionId ?? "")).toBeUndefined()
    })

    test("#then findBySession stays undefined after cleanup even when global registry retains task", async () => {
      // Registry fallback belongs only in resume: registry records are detached, so poller cannot observe their mutation.
      // given
      jest.useFakeTimers()
      Date.now = () => currentTime
      managerUnderTest = createManager()
      const sessionId = "session-registry-only"
      const task = createTask({ id: sessionId, sessionId })
      addTask(managerUnderTest, task)
      scheduleRemoval(managerUnderTest, task.id)

      // when
      currentTime += TASK_CLEANUP_DELAY_MS + 1
      jest.advanceTimersByTime(TASK_CLEANUP_DELAY_MS + 1)

      // then
      expect(getRegisteredBackgroundTask(task.id)).toBeDefined()
      expect(managerUnderTest.findBySession(task.sessionId ?? "")).toBeUndefined()
    })
  })

  describe("#given terminal TTL pruning runs", () => {
    test("#then keeps an old terminal task while its block is within the expiry window", () => {
      // given
      currentTime += TERMINAL_TASK_TTL_MS + 1
      Date.now = () => currentTime
      const task = createTask({
        blockedAt: new Date(currentTime),
        blockedReason: "Need input",
        completedAt: new Date(currentTime - TERMINAL_TASK_TTL_MS - 1),
      })
      const tasks = new Map([[task.id, task]])

      // when
      prune(tasks)

      // then
      expect(tasks.get(task.id)).toBe(task)
    })

    test("#then removes an old terminal task once its block reaches hard expiry", () => {
      // given
      currentTime += TERMINAL_TASK_TTL_MS + 1
      Date.now = () => currentTime
      const task = createTask({
        blockedAt: new Date(currentTime - DEFAULT_BLOCKED_EXPIRY_MS),
        blockedReason: "Need input",
        completedAt: new Date(currentTime - TERMINAL_TASK_TTL_MS - 1),
      })
      const tasks = new Map([[task.id, task]])

      // when
      prune(tasks)

      // then
      expect(tasks.has(task.id)).toBe(false)
    })
  })
})
