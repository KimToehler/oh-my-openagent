import { tmpdir } from "node:os"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import * as spawnLimits from "./subagent-spawn-limits"
import {
  _resetForTesting as resetClaudeCodeSessionState,
  clearSessionAgent,
  getSessionAgent,
  subagentSessions,
} from "../claude-code-session-state"
import { BackgroundManager } from "./manager"
import type { ConcurrencyManager } from "./concurrency"
import type { BackgroundTask, BackgroundTaskCompletionReason } from "./types"

const managers: BackgroundManager[] = []

afterEach(() => {
  while (managers.length > 0) managers.pop()?.shutdown()
  resetClaudeCodeSessionState()
})

type ClientRecorder = {
  readonly client: PluginInput["client"]
  readonly promptCalls: string[]
  readonly promptAsyncCalls: string[]
}

function createClient(abort: () => Promise<unknown> = async () => ({ data: true })): ClientRecorder {
  const promptCalls: string[] = []
  const promptAsyncCalls: string[] = []
  const session = {
    abort,
    create: async () => ({ data: { id: "unused" } }),
    get: async () => ({ data: { directory: tmpdir() } }),
    messages: async () => ({ data: [] }),
    prompt: async (input: { path: { id: string } }) => {
      promptCalls.push(input.path.id)
      return { data: { info: {}, parts: [] } }
    },
    promptAsync: async (input: { path: { id: string } }) => {
      promptAsyncCalls.push(input.path.id)
      return { data: undefined }
    },
  }
  const client = { session } as unknown as PluginInput["client"]
  return { client, promptCalls, promptAsyncCalls }
}

function createManager(recorder: ClientRecorder): BackgroundManager {
  const manager = new BackgroundManager({
    pluginContext: {
      $: {} as PluginInput["$"],
      client: recorder.client,
      directory: tmpdir(),
      project: {} as PluginInput["project"],
      serverUrl: new URL("http://localhost"),
      worktree: tmpdir(),
    },
  })
  managers.push(manager)
  return manager
}

function getRootDescendantCounts(manager: BackgroundManager): Map<string, number> {
  return Reflect.get(manager, "rootDescendantCounts") as Map<string, number>
}

function getConcurrencyManager(manager: BackgroundManager): ConcurrencyManager {
  return Reflect.get(manager, "concurrencyManager") as ConcurrencyManager
}

async function completeTask(manager: BackgroundManager, task: BackgroundTask): Promise<boolean> {
  const tryCompleteTask = Reflect.get(manager, "tryCompleteTask") as (task: BackgroundTask, source: string, reason: BackgroundTaskCompletionReason) => Promise<boolean>
  return tryCompleteTask.call(manager, task, "test", "idle-status")
}

describe("BackgroundManager.adoptRunningSession", () => {
  test("#given a live sync child after sync cleanup #when adopted #then it is a running indexed subagent with fresh activity and no prompt", () => {
    // given
    const recorder = createClient()
    const manager = createManager(recorder)
    const sessionId = "sync-child"
    const parentSessionId = "parent"
    subagentSessions.add(sessionId)
    clearSessionAgent(sessionId)
    subagentSessions.delete(sessionId)

    // when
    const task = manager.adoptRunningSession({
      sessionId,
      parentSessionId,
      parentMessageId: "message",
      description: "adopted work",
      agent: "atlas",
      model: { providerID: "openai", modelID: "gpt-5" },
      rootSessionId: "root",
      rootDescendantAlreadyReserved: true,
    })

    // then
    expect(task.status).toBe("running")
    expect(task.startedAt).toBeInstanceOf(Date)
    expect(task.progress).toEqual({ toolCalls: 0, lastUpdate: expect.any(Date) })
    expect(task.concurrencyKey).toBeUndefined()
    expect(subagentSessions.has(sessionId)).toBe(true)
    expect(getSessionAgent(sessionId)).toBe("atlas")
    expect(manager.getTasksByParentSession(parentSessionId)).toContainEqual(task)
    expect(recorder.promptCalls).toEqual([])
    expect(recorder.promptAsyncCalls).toEqual([])
  })

  test("#given a live sync child #when adopted #then spawn depth and concurrency acquire are not used", () => {
    // given
    const recorder = createClient()
    const manager = createManager(recorder)
    const resolveSpawnDepth = spyOn(spawnLimits, "resolveSubagentSpawnContext")
    const concurrencyManager = getConcurrencyManager(manager)
    const acquire = spyOn(concurrencyManager, "acquire")

    // when
    manager.adoptRunningSession({
      sessionId: "sync-child",
      parentSessionId: "parent",
      parentMessageId: "message",
      description: "adopted work",
      agent: "atlas",
      model: undefined,
      rootSessionId: "root",
      rootDescendantAlreadyReserved: true,
    })

    // then
    expect(resolveSpawnDepth).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
    resolveSpawnDepth.mockRestore()
    acquire.mockRestore()
  })

  test("#given a committed root descendant #when its adopted task completes #then count returns to pre-spawn value without releasing a slot", async () => {
    // given
    const recorder = createClient()
    const manager = createManager(recorder)
    const rootSessionId = "root"
    getRootDescendantCounts(manager).set(rootSessionId, 1)
    const concurrencyManager = getConcurrencyManager(manager)
    const release = spyOn(concurrencyManager, "release")
    const task = manager.adoptRunningSession({
      sessionId: "sync-child",
      parentSessionId: "parent",
      parentMessageId: "message",
      description: "adopted work",
      agent: "atlas",
      model: undefined,
      rootSessionId,
      rootDescendantAlreadyReserved: true,
    })

    // when
    const completed = await completeTask(manager, task)

    // then
    expect(completed).toBe(true)
    expect(getRootDescendantCounts(manager).has(rootSessionId)).toBe(false)
    expect(release).not.toHaveBeenCalled()
    release.mockRestore()
  })

  test("#given continuation adoption without a pre-reserved root descendant #when completion follows adoption #then root count returns to its original value", async () => {
    // given
    const recorder = createClient()
    const manager = createManager(recorder)
    const rootSessionId = "continuation-root"
    const rootDescendantCounts = getRootDescendantCounts(manager)
    rootDescendantCounts.set(rootSessionId, 3)
    const adopt = Reflect.get(manager, "adoptRunningSession") as (input: {
      sessionId: string
      parentSessionId: string
      parentMessageId: string
      description: string
      agent: string
      model: undefined
      rootSessionId: string
      rootDescendantAlreadyReserved: boolean
    }) => BackgroundTask

    // when
    const task = adopt.call(manager, {
      sessionId: "continuation-child",
      parentSessionId: "parent",
      parentMessageId: "message",
      description: "continued work",
      agent: "atlas",
      model: undefined,
      rootSessionId,
      rootDescendantAlreadyReserved: false,
    })
    await completeTask(manager, task)

    // then
    expect(rootDescendantCounts.get(rootSessionId)).toBe(3)
  })

  test("#given repeated adoption of one live child #when adopt is called twice #then it returns one task without duplicate history or root ownership", () => {
    // given
    const recorder = createClient()
    const manager = createManager(recorder)
    const rootSessionId = "root"
    const rootDescendantCounts = getRootDescendantCounts(manager)
    rootDescendantCounts.set(rootSessionId, 3)
    const updateMarker = spyOn(manager as never, "updateBackgroundTaskMarker" as never)
    const adopt = Reflect.get(manager, "adoptRunningSession") as (input: {
      sessionId: string
      parentSessionId: string
      parentMessageId: string
      description: string
      agent: string
      model: undefined
      rootSessionId: string
      rootDescendantAlreadyReserved: boolean
    }) => BackgroundTask
    const input = {
      sessionId: "duplicate-child",
      parentSessionId: "parent",
      parentMessageId: "message",
      description: "adopted work",
      agent: "atlas",
      model: undefined,
      rootSessionId,
      rootDescendantAlreadyReserved: false,
    }

    // when
    const first = adopt.call(manager, input)
    const second = adopt.call(manager, input)

    // then
    expect(second.id).toBe(first.id)
    expect(manager.getTasksByParentSession(input.parentSessionId)).toHaveLength(1)
    expect(rootDescendantCounts.get(rootSessionId)).toBe(4)
    expect(updateMarker).toHaveBeenCalledTimes(1)
    updateMarker.mockRestore()
  })

  test("#given cancellation awaits abort #when completion wins race #then only completion terminal effects run", async () => {
    // given
    let resolveAbort: (() => void) | undefined
    const abort = new Promise<void>((resolve) => { resolveAbort = resolve })
    const recorder = createClient(async () => {
      await abort
      return { data: true }
    })
    const manager = createManager(recorder)
    const rootSessionId = "root"
    getRootDescendantCounts(manager).set(rootSessionId, 1)
    let notificationCount = 0
    Reflect.set(manager, "notifyParentSession", async () => { notificationCount += 1 })
    const task = manager.adoptRunningSession({
      sessionId: "sync-child",
      parentSessionId: "parent",
      parentMessageId: "message",
      description: "adopted work",
      agent: "atlas",
      model: undefined,
      rootSessionId,
      rootDescendantAlreadyReserved: true,
    })

    // when
    const cancelling = manager.cancelTask(task.id)
    const completing = completeTask(manager, task)
    resolveAbort?.()
    const [cancelled, completed] = await Promise.all([cancelling, completing])

    // then
    expect(cancelled).toBe(true)
    expect(completed).toBe(false)
    expect(task.status).toBe("cancelled")
    expect(getRootDescendantCounts(manager).has(rootSessionId)).toBe(false)
    expect(notificationCount).toBe(1)
  })
})
