import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { dispatchInternalPrompt, releaseAllPromptAsyncReservationsForTesting } from "../../shared/prompt-async-gate"
import type { ConcurrencyManager } from "./concurrency"
import { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"

const managers: BackgroundManager[] = []

function createManager(client: unknown): BackgroundManager {
  const manager = new BackgroundManager({
    pluginContext: { client, directory: "/tmp/blocked-resume-test" } as PluginInput,
  })
  managers.push(manager)
  return manager
}

function addBlockedTask(manager: BackgroundManager, sessionId: string): BackgroundTask {
  const task: BackgroundTask = {
    id: `task-${sessionId}`,
    sessionId,
    parentSessionId: "parent-original",
    parentMessageId: "message-original",
    description: "blocked task",
    prompt: "original prompt",
    agent: "explore",
    status: "cancelled",
    startedAt: new Date(),
    completedAt: new Date(),
    blockedAt: new Date(),
    blockedReason: "Need parent input",
    concurrencyGroup: "explore",
  }
  const tasks = Reflect.get(manager, "tasks")
  if (!(tasks instanceof Map)) throw new Error("BackgroundManager tasks map unavailable")
  tasks.set(task.id, task)
  return task
}

function getConcurrencyManager(manager: BackgroundManager): ConcurrencyManager {
  const concurrencyManager = Reflect.get(manager, "concurrencyManager")
  if (typeof concurrencyManager !== "object" || concurrencyManager === null) {
    throw new Error("BackgroundManager concurrency manager unavailable")
  }
  return concurrencyManager as ConcurrencyManager
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

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown()
  releaseAllPromptAsyncReservationsForTesting()
})

describe("BackgroundManager blocked resume", () => {
  test("#given a blocked cancelled task #when dispatch accepts the parent answer #then task resumes and clears blocked state", async () => {
    // given
    const client = { session: { promptAsync: async () => ({}), abort: async () => ({}) } }
    const manager = createManager(client)
    const task = addBlockedTask(manager, "session-dispatched")

    // when
    await resume(manager, task.sessionId)

    // then
    expect(task.status).toBe("running")
    expect(task.blockedAt).toBeUndefined()
    expect(task.blockedReason).toBeUndefined()
    const blockedNotificationTaskIds = Reflect.get(manager, "blockedNotificationTaskIds")
    expect(blockedNotificationTaskIds).toBeInstanceOf(Set)
    expect(blockedNotificationTaskIds.has(task.id)).toBe(false)
  })

  test("#given a blocked task #when active-session gate skips resume #then blocked state remains answerable", async () => {
    // given
    let blockedAtDuringGate: Date | undefined
    let blockedReasonDuringGate: string | undefined
    let task: BackgroundTask
    const client = {
      session: {
        status: async () => {
          blockedAtDuringGate = task.blockedAt
          blockedReasonDuringGate = task.blockedReason
          return { data: { "session-skipped": { type: "busy" } } }
        },
        promptAsync: async () => ({}),
        abort: async () => ({}),
      },
    }
    const manager = createManager(client)
    task = addBlockedTask(manager, "session-skipped")
    const blockedAt = task.blockedAt

    // when
    await resume(manager, task.sessionId)

    // then
    expect(task.status).toBe("cancelled")
    expect(blockedAtDuringGate).toBe(blockedAt)
    expect(blockedReasonDuringGate).toBe("Need parent input")
    expect(task.blockedAt).toBe(blockedAt)
    expect(task.blockedReason).toBe("Need parent input")
  })

  test("#given a blocked task #when resume is queued behind a reservation #then blocked state remains intact", async () => {
    // given
    const client = { session: { promptAsync: async () => ({}), abort: async () => ({}) } }
    await dispatchInternalPrompt({
      mode: "async",
      client,
      sessionID: "session-queued",
      source: "blocked-resume-test-reservation",
      settleMs: 0,
      postDispatchHoldMs: 1000,
      input: { path: { id: "session-queued" }, body: { parts: [] } },
    })
    const manager = createManager(client)
    const task = addBlockedTask(manager, "session-queued")
    const blockedAt = task.blockedAt

    // when
    await resume(manager, task.sessionId)

    // then
    expect(task.blockedAt).toBe(blockedAt)
    expect(task.blockedReason).toBe("Need parent input")
  })

  test("#given parking released the blocked task slot #when parent answer resumes it #then one concurrency slot is reacquired", async () => {
    // given
    const client = { session: { promptAsync: async () => ({}), abort: async () => ({}) } }
    const manager = createManager(client)
    const task = addBlockedTask(manager, "session-concurrency")
    const concurrencyManager = getConcurrencyManager(manager)
    expect(concurrencyManager.getCount("explore")).toBe(0)

    // when
    await resume(manager, task.sessionId)

    // then
    expect(concurrencyManager.getCount("explore")).toBe(1)
    expect(task.concurrencyKey).toBe("explore")
  })
})
