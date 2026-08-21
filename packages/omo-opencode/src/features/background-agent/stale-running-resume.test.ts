import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { releaseAllPromptAsyncReservationsForTesting } from "../../shared/prompt-async-gate"
import { MIN_SESSION_GONE_POLLS } from "./session-existence"
import { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"

const managers: BackgroundManager[] = []

type SessionStatusData = Record<string, { type: string }>

function createManager(client: unknown): BackgroundManager {
  const manager = new BackgroundManager({
    pluginContext: { client, directory: "/tmp/stale-running-resume-test" } as PluginInput,
  })
  managers.push(manager)
  return manager
}

function createClient(options: {
  statuses?: SessionStatusData
  statusThrows?: boolean
  omitStatusMethod?: boolean
  onPrompt?: () => void
}) {
  const session: Record<string, unknown> = {
    promptAsync: async () => {
      options.onPrompt?.()
      return {}
    },
    abort: async () => ({ data: true }),
    messages: async () => ({ data: [] }),
  }
  if (!options.omitStatusMethod) {
    session.status = async () => {
      if (options.statusThrows) throw new Error("status endpoint unavailable")
      return { data: options.statuses ?? {} }
    }
  }
  return { session }
}

function addRunningTask(
  manager: BackgroundManager,
  sessionId: string,
  overrides: Partial<BackgroundTask> = {},
): BackgroundTask {
  const task: BackgroundTask = {
    id: `task-${sessionId}`,
    sessionId,
    parentSessionId: "parent-original",
    parentMessageId: "message-original",
    description: "stale running task",
    prompt: "original prompt",
    agent: "explore",
    status: "running",
    startedAt: new Date(Date.now() - 60 * 60_000),
    progress: { toolCalls: 4, lastUpdate: new Date(Date.now() - 45 * 60_000) },
    concurrencyGroup: "explore",
    ...overrides,
  }
  const tasks = Reflect.get(manager, "tasks")
  if (!(tasks instanceof Map)) throw new Error("BackgroundManager tasks map unavailable")
  tasks.set(task.id, task)
  return task
}

async function flushResumeDispatch(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

async function resume(manager: BackgroundManager, sessionId: string): Promise<void> {
  await manager.resume({
    sessionId,
    prompt: "parent answer",
    parentSessionId: "parent-new",
    parentMessageId: "message-new",
  })
  await flushResumeDispatch()
}

const RUNNING_REJECTION = "is currently running and cannot accept a continuation prompt"

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown()
  releaseAllPromptAsyncReservationsForTesting()
})

describe("BackgroundManager.resume liveness reconciliation", () => {
  test("#given a dead session absent from the status map beyond the gone threshold #when resume is called #then it reconciles and accepts the continuation", async () => {
    // given
    const client = createClient({ statuses: {} })
    const manager = createManager(client)
    const task = addRunningTask(manager, "session-dead", {
      consecutiveMissedPolls: MIN_SESSION_GONE_POLLS,
    })

    // when
    await resume(manager, "session-dead")

    // then
    expect(task.parentSessionId).toBe("parent-new")
    expect(task.parentMessageId).toBe("message-new")
  })

  test("#given a genuinely busy session #when resume is called #then it still rejects the continuation", async () => {
    // given
    const client = createClient({ statuses: { "session-busy": { type: "busy" } } })
    const manager = createManager(client)
    const task = addRunningTask(manager, "session-busy")

    // when
    const attempt = manager.resume({
      sessionId: "session-busy",
      prompt: "parent answer",
      parentSessionId: "parent-new",
      parentMessageId: "message-new",
    })

    // then
    await expect(attempt).rejects.toThrow(RUNNING_REJECTION)
    expect(task.status).toBe("running")
    expect(task.parentSessionId).toBe("parent-original")
  })

  test("#given an absent session below the gone threshold #when resume is called #then it rejects rather than trusting a single blip", async () => {
    // given
    const client = createClient({ statuses: {} })
    const manager = createManager(client)
    const task = addRunningTask(manager, "session-blip", {
      consecutiveMissedPolls: MIN_SESSION_GONE_POLLS - 1,
    })

    // when
    const attempt = manager.resume({
      sessionId: "session-blip",
      prompt: "parent answer",
      parentSessionId: "parent-new",
      parentMessageId: "message-new",
    })

    // then
    await expect(attempt).rejects.toThrow(RUNNING_REJECTION)
    expect(task.status).toBe("running")
    expect(task.parentSessionId).toBe("parent-original")
  })

  test("#given the status endpoint throws #when resume is called #then it fails safe and rejects", async () => {
    // given
    const client = createClient({ statusThrows: true })
    const manager = createManager(client)
    const task = addRunningTask(manager, "session-unknown", {
      consecutiveMissedPolls: MIN_SESSION_GONE_POLLS,
    })

    // when
    const attempt = manager.resume({
      sessionId: "session-unknown",
      prompt: "parent answer",
      parentSessionId: "parent-new",
      parentMessageId: "message-new",
    })

    // then
    await expect(attempt).rejects.toThrow(RUNNING_REJECTION)
    expect(task.status).toBe("running")
  })

  test("#given session.status is unavailable on the client #when resume is called #then it fails safe and rejects", async () => {
    // given
    const client = createClient({ omitStatusMethod: true })
    const manager = createManager(client)
    const task = addRunningTask(manager, "session-nostatus", {
      consecutiveMissedPolls: MIN_SESSION_GONE_POLLS,
    })

    // when
    const attempt = manager.resume({
      sessionId: "session-nostatus",
      prompt: "parent answer",
      parentSessionId: "parent-new",
      parentMessageId: "message-new",
    })

    // then
    await expect(attempt).rejects.toThrow(RUNNING_REJECTION)
    expect(task.status).toBe("running")
  })

  test("#given a terminal idle session #when resume is called #then it reconciles without waiting for the gone threshold", async () => {
    // given
    const client = createClient({ statuses: { "session-idle": { type: "idle" } } })
    const manager = createManager(client)
    const task = addRunningTask(manager, "session-idle")

    // when
    await resume(manager, "session-idle")

    // then
    expect(task.parentSessionId).toBe("parent-new")
  })

  test("#given the poller already claimed the task for completion #when resume is called #then it rejects instead of racing", async () => {
    // given
    const client = createClient({ statuses: {} })
    const manager = createManager(client)
    const task = addRunningTask(manager, "session-claimed", {
      consecutiveMissedPolls: MIN_SESSION_GONE_POLLS,
    })
    const completingTaskIds = Reflect.get(manager, "completingTaskIds")
    if (!(completingTaskIds instanceof Set)) throw new Error("completingTaskIds unavailable")
    completingTaskIds.add(task.id)

    // when
    const attempt = manager.resume({
      sessionId: "session-claimed",
      prompt: "parent answer",
      parentSessionId: "parent-new",
      parentMessageId: "message-new",
    })

    // then
    await expect(attempt).rejects.toThrow(RUNNING_REJECTION)
    expect(task.parentSessionId).toBe("parent-original")
  })

  test("#given a reconciled dead task #when resume re-acquires concurrency #then the dead run's slot is released rather than leaked", async () => {
    // given
    const client = createClient({ statuses: {} })
    const manager = createManager(client)
    const task = addRunningTask(manager, "session-slot", {
      consecutiveMissedPolls: MIN_SESSION_GONE_POLLS,
      concurrencyKey: "explore",
    })
    const concurrencyManager = Reflect.get(manager, "concurrencyManager")
    if (typeof concurrencyManager !== "object" || concurrencyManager === null) {
      throw new Error("concurrency manager unavailable")
    }
    const released: string[] = []
    const originalRelease = Reflect.get(concurrencyManager, "release")
    if (typeof originalRelease !== "function") throw new Error("release unavailable")
    Reflect.set(concurrencyManager, "release", (key: string) => {
      released.push(key)
      return originalRelease.call(concurrencyManager, key)
    })

    // when
    await resume(manager, "session-slot")

    // then
    expect(released).toContain("explore")
    expect(task.parentSessionId).toBe("parent-new")
  })
})
