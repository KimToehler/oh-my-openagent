/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { tmpdir } from "node:os"
import { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"
import { ConcurrencyManager } from "./concurrency"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"

type ManagerInternals = {
  concurrencyManager: ConcurrencyManager
  tasks: Map<string, BackgroundTask>
  queuesByKey: Map<string, unknown[]>
  processKey: (key: string) => Promise<void>
  startTask: (item: unknown) => Promise<void>
  rollbackPreStartDescendantReservation: (task: BackgroundTask) => void
}

function createManager(): BackgroundManager {
  const client = {
    session: {
      prompt: async () => ({}),
      promptAsync: async () => ({}),
      abort: async () => ({}),
    },
  }

  const manager = new BackgroundManager({
    pluginContext: unsafeTestValue<PluginInput>({ client, directory: tmpdir() }),
    config: { providerConcurrency: { onara: 1 } },
  })

  const testManager = unsafeTestValue<{
    enqueueNotificationForParent: (sessionId: string, fn: () => Promise<void>) => Promise<void>
    notifyParentSession: (task: BackgroundTask) => Promise<void>
  }>(manager)
  testManager.enqueueNotificationForParent = async (_sessionId, fn) => {
    await fn()
  }
  testManager.notifyParentSession = async () => {}

  return manager
}

function internals(manager: BackgroundManager): ManagerInternals {
  return unsafeTestValue<ManagerInternals>(manager)
}

function makeTask(id: string): BackgroundTask {
  return unsafeTestValue<BackgroundTask>({
    id,
    sessionId: undefined,
    parentSessionId: "ses_parent",
    parentMessageId: "",
    description: id,
    prompt: "",
    agent: "explore",
    status: "pending",
    startedAt: new Date(),
    progress: { toolCalls: 0, lastUpdate: new Date() },
  })
}

/**
 * Drives the real `processKey` with `startTask` stalled, reproducing the
 * launch window in which the production code awaits session.get/create before
 * it records the task's concurrency key.
 */
function queueTaskWithStalledStart(manager: BackgroundManager, task: BackgroundTask, rawKey: string) {
  const api = internals(manager)
  const key = api.concurrencyManager.getConcurrencyKey(rawKey)

  let releaseStart: () => void = () => {}
  const startBlocked = new Promise<void>(resolve => {
    releaseStart = resolve
  })
  api.startTask = async () => {
    await startBlocked
  }

  api.tasks.set(task.id, task)
  const queue = api.queuesByKey.get(key) ?? []
  queue.push({ task, input: { agent: task.agent, parentSessionId: task.parentSessionId }, rawConcurrencyKey: rawKey })
  api.queuesByKey.set(key, queue)

  const draining = api.processKey(key)
  return { key, draining, releaseStart }
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 10))

describe("concurrency slot ownership during task launch", () => {
  test("should record the concurrency key as soon as the slot is acquired", async () => {
    // given a task being launched on a single-slot key
    const manager = createManager()
    const task = makeTask("launching")

    // when it has acquired its slot but startTask has not finished
    const { releaseStart } = queueTaskWithStalledStart(manager, task, "onara/explore")
    await settle()

    // then the task already owns the slot, so terminal handlers can release it
    expect(task.concurrencyKey).toBeDefined()

    releaseStart()
  })

  test("should free the slot for a waiter when a task is cancelled mid-launch", async () => {
    // given a saturated single-slot key with a second task waiting
    const manager = createManager()
    const holder = makeTask("holder")
    const { releaseStart } = queueTaskWithStalledStart(manager, holder, "onara/explore")
    await settle()

    holder.status = "running"

    let waiterStarted = false
    const waiter = internals(manager).concurrencyManager
      .acquire("onara/explore", "waiter")
      .then(() => {
        waiterStarted = true
      })
    await settle()
    expect(waiterStarted).toBe(false)

    // when the holder is cancelled while still inside its launch window
    await manager.cancelTask("holder", { abortSession: false })
    await settle()

    // then the freed slot is handed to the waiter instead of being stranded
    expect(waiterStarted).toBe(true)

    releaseStart()
    await waiter
  })
})
