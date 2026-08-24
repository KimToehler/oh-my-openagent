import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { resetLiveServerRouteForTesting } from "../../shared/live-server-route"
import { releaseAllPromptAsyncReservationsForTesting } from "../../shared/prompt-async-gate"
import { BackgroundManager } from "./manager"
import type { AdoptRunningSessionInput, BackgroundTask } from "./types"

const managers: BackgroundManager[] = []

function createManager(hasOutput = false): { readonly manager: BackgroundManager; readonly promptAsync: ReturnType<typeof mock> } {
  const promptAsync = mock(async () => ({ data: undefined }))
  const messages = hasOutput
    ? [{ info: { role: "tool" }, parts: [{ type: "text", text: "work completed" }] }]
    : []
  const client = {
    session: {
      abort: async () => ({ data: true }),
      get: async () => ({ data: { id: "child-session" } }),
      messages: async () => ({ data: messages }),
      prompt: async () => ({ data: { info: {}, parts: [] } }),
      promptAsync,
      status: async () => ({ data: {} }),
      todo: async () => ({ data: [] }),
    },
  }
  const directory = `/tmp/manager-resume-adopt-test-${crypto.randomUUID()}`
  const manager = new BackgroundManager({
    pluginContext: {
      $: {} as PluginInput["$"],
      client: client as unknown as PluginInput["client"],
      directory,
      project: {} as PluginInput["project"],
      worktree: directory,
    },
  })
  managers.push(manager)
  return { manager, promptAsync }
}

function stubMissChecks(
  manager: BackgroundManager,
  sessionExists: boolean,
  liveness: "active" | "terminal" | "absent" | "unknown",
): void {
  spyOn(manager as never, "verifySessionExists" as never).mockResolvedValue(sessionExists as never)
  spyOn(manager as never, "probeSessionLiveness" as never).mockResolvedValue(liveness as never)
}

function resume(manager: BackgroundManager, sessionId = "child-session", parentSessionId = "current-parent") {
  return manager.resume({
    sessionId,
    prompt: "continue work",
    parentSessionId,
    parentMessageId: "current-message",
  })
}

function getTasks(manager: BackgroundManager): Map<string, BackgroundTask> {
  const tasks = Reflect.get(manager, "tasks")
  if (!(tasks instanceof Map)) throw new Error("BackgroundManager tasks map unavailable")
  return tasks
}

function getRootDescendantCount(manager: BackgroundManager, rootSessionId: string): number {
  const counts = Reflect.get(manager, "rootDescendantCounts")
  if (!(counts instanceof Map)) throw new Error("BackgroundManager root descendant counts unavailable")
  return counts.get(rootSessionId) ?? 0
}

function failConcurrencyAcquire(manager: BackgroundManager): void {
  const concurrencyManager = Reflect.get(manager, "concurrencyManager")
  if (typeof concurrencyManager !== "object" || concurrencyManager === null) {
    throw new Error("BackgroundManager concurrency manager unavailable")
  }
  spyOn(concurrencyManager as never, "acquire" as never).mockRejectedValue(new Error("forced acquire failure") as never)
}

async function completeTask(manager: BackgroundManager, task: BackgroundTask): Promise<boolean> {
  const tryCompleteTask = Reflect.get(manager, "tryCompleteTask")
  if (typeof tryCompleteTask !== "function") throw new Error("BackgroundManager completion method unavailable")
  return tryCompleteTask.call(manager, task, "test")
}

async function flushResumeDispatch(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

afterEach(() => {
  while (managers.length > 0) managers.pop()?.shutdown()
  releaseAllPromptAsyncReservationsForTesting()
  resetLiveServerRouteForTesting()
})

describe("BackgroundManager resume adopt-on-miss", () => {
  test("#given a terminal child session missing from memory #when resume adopts it #then exact continuation metadata and task identity are preserved", async () => {
    // given
    const { manager } = createManager()
    stubMissChecks(manager, true, "terminal")
    const adopt = spyOn(manager, "adoptRunningSession")

    // when
    const resumed = await resume(manager)

    // then
    const expectedInput: AdoptRunningSessionInput = {
      sessionId: "child-session",
      parentSessionId: "current-parent",
      parentMessageId: "current-message",
      description: "Resumed orphaned background session child-session",
      agent: "continue",
      model: undefined,
      rootSessionId: "current-parent",
      rootDescendantAlreadyReserved: false,
    }
    expect(adopt).toHaveBeenCalledWith(expectedInput)
    expect(getTasks(manager).get(resumed.id)).toBe(resumed)
  })

  test("#given an active child session missing from memory #when resume is requested #then it refuses without dispatching a prompt", async () => {
    // given
    const { manager, promptAsync } = createManager()
    stubMissChecks(manager, true, "active")

    // when
    const result = resume(manager)

    // then
    await expect(result).rejects.toThrow("currently running and cannot accept a continuation prompt")
    expect(promptAsync).not.toHaveBeenCalled()
  })

  test("#given unknown child liveness missing from memory #when resume is requested #then it refuses without dispatching a prompt", async () => {
    // given
    const { manager, promptAsync } = createManager()
    stubMissChecks(manager, true, "unknown")

    // when
    const result = resume(manager)

    // then
    await expect(result).rejects.toThrow("currently running and cannot accept a continuation prompt")
    expect(promptAsync).not.toHaveBeenCalled()
  })

  test("#given no durable child session after restart #when resume is requested #then it reports restart recovery guidance", async () => {
    // given
    const { manager } = createManager()
    stubMissChecks(manager, false, "terminal")

    // when
    const result = resume(manager)

    // then
    await expect(result).rejects.toThrow(/process restart/i)
  })

  test("#given an idle existing orphan with assistant output omitted from the real status registry #when resume is requested #then it adopts and dispatches one prompt", async () => {
    // given
    const { manager, promptAsync } = createManager(true)

    // when
    const resumed = await resume(manager)
    await flushResumeDispatch()

    // then
    expect(getTasks(manager).get(resumed.id)).toBe(resumed)
    expect(promptAsync).toHaveBeenCalledTimes(1)
  })

  test("#given an existing orphan without agent output omitted from the status registry #when resume is requested #then it refuses with transcript guidance", async () => {
    // given
    const { manager, promptAsync } = createManager()

    // when
    const result = resume(manager)

    // then
    await expect(result).rejects.toThrow(/exists but shows no agent output to continue from/i)
    await expect(result).rejects.toThrow('session_read(session_id="child-session")')
    expect(promptAsync).not.toHaveBeenCalled()
  })

  test("#given idle orphan adoption followed by concurrency acquire failure #when resume rejects #then adoption and descendant registration roll back", async () => {
    // given
    const { manager, promptAsync } = createManager(true)
    failConcurrencyAcquire(manager)
    const beforeCount = getRootDescendantCount(manager, "current-parent")

    // when
    const result = resume(manager)

    // then
    await expect(result).rejects.toThrow("forced acquire failure")
    expect(getRootDescendantCount(manager, "current-parent")).toBe(beforeCount)
    expect(getTasks(manager).size).toBe(0)
    expect(promptAsync).not.toHaveBeenCalled()
  })

  test("#given nested-parent terminal adoption #when resumed task completes #then root descendant registers and unregisters exactly once", async () => {
    // given
    const { manager } = createManager()
    stubMissChecks(manager, true, "terminal")
    const register = spyOn(manager as never, "registerRootDescendant" as never)
    const unregister = spyOn(manager as never, "unregisterRootDescendant" as never)

    // when
    const resumed = await resume(manager, "nested-child", "nested-parent")
    await flushResumeDispatch()
    const completed = await completeTask(manager, resumed)

    // then
    expect(completed).toBe(true)
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith("nested-parent")
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(unregister).toHaveBeenCalledWith("nested-parent")
  })
})
