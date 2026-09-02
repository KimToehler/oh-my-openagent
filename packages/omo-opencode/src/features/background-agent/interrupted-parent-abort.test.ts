import { tmpdir } from "node:os"
import { describe, test, expect, afterAll, afterEach, mock } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { BackgroundManager } from "./manager"
import { clearBackgroundTaskRegistryForTesting } from "./task-registry"
import type { BackgroundTask } from "./types"

afterAll(() => { mock.restore() })
afterEach(() => { clearBackgroundTaskRegistryForTesting() })

const PARENT_SESSION_ID = "session-parent-abort"

function cast<T>(value: unknown): T {
  return value as T
}

function createBackgroundManager(): BackgroundManager {
  const client = {
    session: {
      prompt: async () => ({}),
      promptAsync: async () => ({}),
      abort: async () => ({}),
      get: async () => ({ data: { id: PARENT_SESSION_ID } }),
    },
  }
  return new BackgroundManager({ pluginContext: cast<PluginInput>({ client, directory: tmpdir() }) })
}

function getTaskMap(manager: BackgroundManager): Map<string, BackgroundTask> {
  return cast<{ tasks: Map<string, BackgroundTask> }>(manager).tasks
}

async function flushBackgroundNotifications(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve()
  }
}

function createMockTask(overrides: Partial<BackgroundTask>): BackgroundTask {
  return cast<BackgroundTask>({
    id: "task",
    agent: "explore",
    description: "lane",
    prompt: "do work",
    status: "running",
    parentSessionId: PARENT_SESSION_ID,
    startedAt: new Date(),
    ...overrides,
  })
}

describe("BackgroundManager.handleEvent - interrupted parent", () => {
  test("#given a parent session interrupted by the user while its lanes are still running #when session.error carries an abort-shaped error for the parent #then the child tasks are terminalized rather than left running until the stale reaper", async () => {
    //#given
    const manager = createBackgroundManager()
    const childA = createMockTask({
      id: "task-child-a",
      sessionId: "session-child-a",
      parentSessionId: PARENT_SESSION_ID,
      status: "running",
    })
    const childB = createMockTask({
      id: "task-child-b",
      sessionId: "session-child-b",
      parentSessionId: PARENT_SESSION_ID,
      status: "pending",
      startedAt: undefined,
      queuedAt: new Date(),
    })
    const unrelated = createMockTask({
      id: "task-unrelated",
      sessionId: "session-unrelated",
      parentSessionId: "other-parent",
      status: "running",
    })

    const taskMap = getTaskMap(manager)
    taskMap.set(childA.id, childA)
    taskMap.set(childB.id, childB)
    taskMap.set(unrelated.id, unrelated)

    //#when
    manager.handleEvent(cast<Parameters<BackgroundManager["handleEvent"]>[0]>({
      type: "session.error",
      properties: {
        sessionID: PARENT_SESSION_ID,
        error: { name: "AbortError", message: "Session aborted" },
      },
    }))

    await flushBackgroundNotifications()
    await flushBackgroundNotifications()

    //#then
    expect(childA.status).toBe("cancelled")
    expect(childB.status).toBe("cancelled")
    expect(unrelated.status).toBe("running")

    manager.shutdown()
  })
})
