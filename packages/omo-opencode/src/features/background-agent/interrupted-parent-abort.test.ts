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

    await manager.shutdown()
  })

  test("#given a parent session that failed for a NON-interrupt reason #when session.error carries a provider error whose prose merely contains the word aborted #then the child lanes keep running", async () => {
    //#given
    const manager = createBackgroundManager()
    const child = createMockTask({
      id: "task-child-transport",
      sessionId: "session-child-transport",
      parentSessionId: PARENT_SESSION_ID,
      status: "running",
    })
    getTaskMap(manager).set(child.id, child)

    //#when
    // A transport failure, not a user interrupt. The loose `isAbortedSessionError`
    // substring test matches this string, which is why the destructive path must
    // key on the structured error NAME instead.
    manager.handleEvent(cast<Parameters<BackgroundManager["handleEvent"]>[0]>({
      type: "session.error",
      properties: {
        sessionID: PARENT_SESSION_ID,
        error: { name: "ProviderTransportError", message: "connection aborted by upstream" },
      },
    }))

    await flushBackgroundNotifications()
    await flushBackgroundNotifications()

    //#then
    expect(child.status).toBe("running")

    await manager.shutdown()
  })

  test("#given an interrupted session that is itself a tracked lane #when session.error carries an abort for that lane #then its siblings under the same parent are untouched", async () => {
    //#given
    const manager = createBackgroundManager()
    const interruptedLane = createMockTask({
      id: "task-self",
      sessionId: "session-self",
      parentSessionId: PARENT_SESSION_ID,
      status: "running",
      isCurrent: true,
    })
    const sibling = createMockTask({
      id: "task-sibling",
      sessionId: "session-sibling",
      parentSessionId: "session-self",
      status: "running",
    })

    const taskMap = getTaskMap(manager)
    taskMap.set(interruptedLane.id, interruptedLane)
    taskMap.set(sibling.id, sibling)

    //#when
    manager.handleEvent(cast<Parameters<BackgroundManager["handleEvent"]>[0]>({
      type: "session.error",
      properties: {
        sessionID: "session-self",
        error: { name: "MessageAbortedError", data: { message: "Aborted" } },
      },
    }))

    await flushBackgroundNotifications()
    await flushBackgroundNotifications()

    //#then
    // A lane's own abort is handled by the lane's own error path, which owns
    // retry and fallback. Cascading from here would cancel work that path may
    // still recover.
    expect(sibling.status).toBe("running")

    await manager.shutdown()
  })

  test("#given a parent interrupted by the user #when its lanes are terminalized #then no parent notification is queued, because a wake would restart the turn the user just stopped", async () => {
    //#given
    const manager = createBackgroundManager()
    const child = createMockTask({
      id: "task-child-nowake",
      sessionId: "session-child-nowake",
      parentSessionId: PARENT_SESSION_ID,
      status: "running",
    })
    getTaskMap(manager).set(child.id, child)

    //#when
    manager.handleEvent(cast<Parameters<BackgroundManager["handleEvent"]>[0]>({
      type: "session.error",
      properties: {
        sessionID: PARENT_SESSION_ID,
        error: { name: "MessageAbortedError", data: { message: "Aborted" } },
      },
    }))

    await flushBackgroundNotifications()
    await flushBackgroundNotifications()

    //#then
    expect(child.status).toBe("cancelled")
    expect(manager.getPendingNotifications(PARENT_SESSION_ID)).toHaveLength(0)

    await manager.shutdown()
  })
})
