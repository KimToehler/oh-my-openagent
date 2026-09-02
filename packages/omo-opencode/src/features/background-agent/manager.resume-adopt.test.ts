import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { rmSync } from "node:fs"
import type { PluginInput } from "@opencode-ai/plugin"
import { resetLiveServerRouteForTesting } from "../../shared/live-server-route"
import { releaseAllPromptAsyncReservationsForTesting } from "../../shared/prompt-async-gate"
import {
  _resetForTesting as resetClaudeCodeSessionState,
  getSessionAgent,
  subagentSessions,
} from "../claude-code-session-state"
import { setPromptReservation } from "@oh-my-opencode/utils/prompt-async-gate/reservations"
import { readContinuationMarker } from "../run-continuation-state"
import { BackgroundManager } from "./manager"
import type { AdoptRunningSessionInput, BackgroundTask, BackgroundTaskCompletionReason } from "./types"

const managers: BackgroundManager[] = []
const managerDirectories: string[] = []
// A real session always ran under some agent, so the shared fixtures carry one:
// adoption now refuses when the transcript cannot identify the owning agent.
const ADOPTED_AGENT = "momus"
const ADOPTED_MODEL = { providerID: "anthropic", modelID: "claude-opus-4" }
const completedTranscript = [
  {
    info: {
      role: "assistant",
      time: { completed: 1 },
      finish: "stop",
      agent: ADOPTED_AGENT,
      model: ADOPTED_MODEL,
    },
    parts: [{ type: "text", text: "work completed" }],
  },
]
const unterminatedTranscript = [
  {
    info: { role: "assistant", time: {}, agent: ADOPTED_AGENT, model: ADOPTED_MODEL },
    parts: [{ type: "text", text: "work interrupted" }],
  },
]
const agentlessTranscript = [
  {
    info: { role: "assistant", time: { completed: 1 }, finish: "stop" },
    parts: [{ type: "text", text: "work completed" }],
  },
]

function createManager(
  messages: readonly Record<string, unknown>[] = [],
): { readonly manager: BackgroundManager; readonly promptAsync: ReturnType<typeof mock> } {
  const promptAsync = mock(async () => ({ data: undefined }))
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
  managerDirectories.push(directory)
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

function suspendConcurrencyAcquire(manager: BackgroundManager): { readonly release: () => void } {
  const concurrencyManager = Reflect.get(manager, "concurrencyManager")
  if (typeof concurrencyManager !== "object" || concurrencyManager === null) {
    throw new Error("BackgroundManager concurrency manager unavailable")
  }
  let release = (): void => {
    throw new Error("Concurrency acquire promise was not initialized")
  }
  const suspended = new Promise<void>((resolve) => {
    release = resolve
  })
  spyOn(concurrencyManager as never, "acquire" as never).mockReturnValue(suspended as never)
  return { release }
}

async function completeTask(manager: BackgroundManager, task: BackgroundTask): Promise<boolean> {
  const tryCompleteTask = Reflect.get(manager, "tryCompleteTask") as (task: BackgroundTask, source: string, reason: BackgroundTaskCompletionReason) => Promise<boolean>
  return tryCompleteTask.call(manager, task, "test", "idle-status")
}

async function flushResumeDispatch(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

afterEach(() => {
  while (managers.length > 0) managers.pop()?.shutdown()
  while (managerDirectories.length > 0) {
    const directory = managerDirectories.pop()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
  releaseAllPromptAsyncReservationsForTesting()
  resetLiveServerRouteForTesting()
  resetClaudeCodeSessionState()
})

describe("BackgroundManager resume adopt-on-miss", () => {
  test("#given a terminal child session missing from memory #when resume adopts it #then the agent recovered from the transcript is carried through, never a fabricated name", async () => {
    // given
    const { manager } = createManager(completedTranscript)
    stubMissChecks(manager, true, "terminal")
    const adopt = spyOn(manager, "adoptRunningSession")
    const reconcile = spyOn(manager as never, "reconcileStaleRunningTask" as never)

    // when
    const resumed = await resume(manager)

    // then
    const expectedInput: AdoptRunningSessionInput = {
      sessionId: "child-session",
      parentSessionId: "current-parent",
      parentMessageId: "current-message",
      description: "Resumed orphaned background session child-session",
      agent: "momus",
      model: { providerID: "anthropic", modelID: "claude-opus-4" },
      rootSessionId: "current-parent",
      rootDescendantAlreadyReserved: false,
    }
    expect(adopt).toHaveBeenCalledWith(expectedInput)
    expect(reconcile).not.toHaveBeenCalled()
    expect(getTasks(manager).get(resumed.id)).toBe(resumed)
    expect(resumed.agent).not.toBe("continue")
  })

  test("#given an orphan whose transcript yields no agent #when resume is requested #then it refuses to adopt rather than substituting a placeholder agent", async () => {
    // given
    const { manager, promptAsync } = createManager(agentlessTranscript)
    stubMissChecks(manager, true, "terminal")
    const adopt = spyOn(manager, "adoptRunningSession")

    // when
    const result = resume(manager)

    // then
    await expect(result).rejects.toThrow(/original agent could not be recovered/i)
    expect(adopt).not.toHaveBeenCalled()
    expect(promptAsync).not.toHaveBeenCalled()
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
    const { manager, promptAsync } = createManager(completedTranscript)

    // when
    const resumed = await resume(manager)
    await flushResumeDispatch()

    // then
    expect(getTasks(manager).get(resumed.id)).toBe(resumed)
    expect(promptAsync).toHaveBeenCalledTimes(1)
  })

  test("#given an unterminated orphan assistant turn #when resume adopts it #then the continuation prompt still dispatches", async () => {
    // given
    const { manager, promptAsync } = createManager(unterminatedTranscript)
    stubMissChecks(manager, true, "terminal")

    // when
    const resumed = await resume(manager)
    await flushResumeDispatch()

    // then
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(getTasks(manager).size).toBe(1)
    expect(subagentSessions.has("child-session")).toBe(true)
    expect(resumed.sessionId).toBe("child-session")
  })

  test("#given an unterminated orphan turn #when liveness probes active #then resume refuses without adopting or dispatching", async () => {
    // given
    const { manager, promptAsync } = createManager(unterminatedTranscript)
    stubMissChecks(manager, true, "active")

    // when
    const result = resume(manager)

    // then
    await expect(result).rejects.toThrow("is currently running")
    expect(promptAsync).not.toHaveBeenCalled()
    expect(getTasks(manager).size).toBe(0)
    expect(subagentSessions.has("child-session")).toBe(false)
  })

  test("#given orphan adoption suspended on concurrency acquire #when completion races #then claim blocks completion until resume starts and is then released", async () => {
    // given
    const { manager } = createManager(completedTranscript)
    const acquire = suspendConcurrencyAcquire(manager)

    // when
    const resumeResult = resume(manager)
    await flushResumeDispatch()
    const adopted = [...getTasks(manager).values()][0]
    if (!adopted) throw new Error("Expected adopted task while resume waits for concurrency")
    const completedWhileSuspended = await completeTask(manager, adopted)

    // then
    expect(completedWhileSuspended).toBe(false)
    expect(adopted.status).toBe("running")
    acquire.release()
    const resumed = await resumeResult
    expect(resumed).toBe(adopted)
    expect(await completeTask(manager, adopted)).toBe(true)
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
    const { manager, promptAsync } = createManager(completedTranscript)
    failConcurrencyAcquire(manager)
    const beforeCount = getRootDescendantCount(manager, "current-parent")

    // when
    const result = resume(manager)

    // then
    await expect(result).rejects.toThrow("forced acquire failure")
    expect(getRootDescendantCount(manager, "current-parent")).toBe(beforeCount)
    expect(getTasks(manager).size).toBe(0)
    expect(subagentSessions.has("child-session")).toBe(false)
    expect(getSessionAgent("child-session")).toBeUndefined()
    expect(promptAsync).not.toHaveBeenCalled()
    expect(readContinuationMarker(managerDirectories.at(-1) ?? "", "current-parent")?.sources["background-task"]?.state).not.toBe("active")
  })

  test("#given a known task followed by concurrency acquire failure #when resume rejects #then no active continuation marker is written", async () => {
    // given
    const { manager } = createManager(completedTranscript)
    const knownTask: BackgroundTask = {
      id: "known-task",
      sessionId: "child-session",
      parentSessionId: "current-parent",
      parentMessageId: "current-message",
      description: "known task",
      prompt: "original prompt",
      agent: "continue",
      status: "completed",
    }
    getTasks(manager).set(knownTask.id, knownTask)
    failConcurrencyAcquire(manager)

    // when
    const result = resume(manager)

    // then
    await expect(result).rejects.toThrow("forced acquire failure")
    expect(readContinuationMarker(managerDirectories.at(-1) ?? "", "current-parent")?.sources["background-task"]?.state).not.toBe("active")
  })

  test("#given nested-parent terminal adoption #when resumed task completes #then root descendant registers and unregisters exactly once", async () => {
    // given
    const { manager } = createManager(completedTranscript)
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

  test("#given an adopted orphan whose session is reserved by another source #when the gate skips the dispatch #then adoption rolls back and reports failure", async () => {
    // given
    const { manager, promptAsync } = createManager(completedTranscript)
    stubMissChecks(manager, true, "terminal")
    const beforeCount = getRootDescendantCount(manager, "current-parent")
    setPromptReservation("child-session", {
      source: "someone-else",
      dedupeKey: undefined,
      reservedAt: Date.now(),
      token: Symbol("someone-else"),
    })

    // when
    const result = resume(manager)

    // then
    await expect(result).rejects.toThrow("continuation prompt was not dispatched")
    expect(promptAsync).not.toHaveBeenCalled()
    expect(getTasks(manager).size).toBe(0)
    expect(getRootDescendantCount(manager, "current-parent")).toBe(beforeCount)
    expect(subagentSessions.has("child-session")).toBe(false)
    expect(getSessionAgent("child-session")).toBeUndefined()
  })

  test("#given a skipped adopted resume #when the same orphan is resumed again #then it is not wedged as running", async () => {
    // given
    const { manager } = createManager(completedTranscript)
    stubMissChecks(manager, true, "terminal")
    setPromptReservation("child-session", {
      source: "someone-else",
      dedupeKey: undefined,
      reservedAt: Date.now(),
      token: Symbol("someone-else"),
    })
    await expect(resume(manager)).rejects.toThrow("continuation prompt was not dispatched")

    // when
    const secondResult = resume(manager)

    // then
    await expect(secondResult).rejects.toThrow("continuation prompt was not dispatched")
    await expect(secondResult).rejects.not.toThrow("is currently running")
  })

  test("#given a task id identical to the parent session #when resume is requested #then it refuses without adopting the parent as its own subagent", async () => {
    // given
    const { manager, promptAsync } = createManager(completedTranscript)
    stubMissChecks(manager, true, "terminal")

    // when
    const result = resume(manager, "current-parent", "current-parent")

    // then
    await expect(result).rejects.toThrow("cannot resume itself")
    expect(promptAsync).not.toHaveBeenCalled()
    expect(getTasks(manager).size).toBe(0)
    expect(subagentSessions.has("current-parent")).toBe(false)
    expect(getSessionAgent("current-parent")).toBeUndefined()
  })
})
