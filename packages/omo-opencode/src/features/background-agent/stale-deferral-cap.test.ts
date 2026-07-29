import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { tmpdir } from "node:os"
import type { PluginInput } from "@opencode-ai/plugin"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"

type PollingManager = {
  readonly pollRunningTasks: () => Promise<void>
  readonly tasks: Map<string, BackgroundTask>
}

function createPluginContext(client: unknown): PluginInput {
  const directory = tmpdir()
  return unsafeTestValue<PluginInput>({
    project: {
      id: "test-project",
      worktree: directory,
      time: { created: Date.now() },
    },
    directory,
    worktree: directory,
    serverUrl: new URL("http://localhost:4096"),
    $: {},
    client,
  })
}

function createRunningTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "bg_test_stale_deferral",
    sessionId: "ses-active",
    parentSessionId: "parent-session",
    parentMessageId: "parent-message",
    description: "test task",
    prompt: "test prompt",
    agent: "explore",
    status: "running",
    startedAt: new Date(Date.now() - 120_000),
    progress: { toolCalls: 0, lastUpdate: new Date() },
    ...overrides,
  }
}

/**
 * A provider stream can open and then produce nothing at all - no token, no
 * error, no abort - while OpenCode keeps reporting the session as `busy`. The
 * task then never leaves `running`, so `staleTimeoutMs` never applies and the
 * lane hangs indefinitely. These tests pin the deferral as BOUNDED: a `busy`
 * status may postpone the stale kill only while some liveness signal actually
 * advances.
 */
describe("BackgroundManager stale-deferral cap", () => {
  const originalDateNow = Date.now
  const fixedTime = new Date("2026-05-21T03:00:00.000Z").getTime()
  const staleTimeoutMs = 180_000

  afterEach(() => {
    Date.now = originalDateNow
    mock.restore()
  })

  test("cancels a busy task when the session lookup stays unavailable across polls", async () => {
    //#given - the task is long past its stale timeout and every session lookup fails
    spyOn(globalThis.Date, "now").mockReturnValue(fixedTime)
    let abortCallCount = 0
    const sessionGet = mock(async () => ({ error: "lookup failed", data: undefined }))
    const client = {
      session: {
        status: async () => ({ data: { "ses-active": { type: "busy" } } }),
        get: sessionGet,
        prompt: async () => ({}),
        promptAsync: async () => ({}),
        abort: async () => {
          abortCallCount += 1
          return {}
        },
        todo: async () => ({ data: [] }),
        messages: async () => ({ data: [] }),
      },
    }
    const manager = new BackgroundManager({
      pluginContext: createPluginContext(client),
      config: { staleTimeoutMs },
      enableParentSessionNotifications: false,
    })
    const task = createRunningTask({
      startedAt: new Date(fixedTime - 45 * 60 * 1000),
      progress: { toolCalls: 3, lastUpdate: new Date(fixedTime - 45 * 60 * 1000) },
    })
    const pollingManager = unsafeTestValue<PollingManager>(manager)
    pollingManager.tasks.set(task.id, task)

    //#when - polling repeats well beyond a single deferral
    for (let i = 0; i < 8; i += 1) {
      await pollingManager.pollRunningTasks()
    }

    //#then - the deferral is capped and the hung task is interrupted
    expect(task.status).toBe("cancelled")
    expect(task.error).toContain("Stale timeout")
    expect(abortCallCount).toBeGreaterThan(0)

    await manager.shutdown()
  })

  test("cancels a busy task when reported activity never advances across polls", async () => {
    //#given - session metadata keeps reporting the SAME timestamp while real time advances
    let nowValue = fixedTime
    spyOn(globalThis.Date, "now").mockImplementation(() => nowValue)
    let abortCallCount = 0
    const pinnedActivity = fixedTime - 1_000
    const client = {
      session: {
        status: async () => ({ data: { "ses-active": { type: "busy" } } }),
        get: async () => ({ data: { time: { updated: pinnedActivity } } }),
        prompt: async () => ({}),
        promptAsync: async () => ({}),
        abort: async () => {
          abortCallCount += 1
          return {}
        },
        todo: async () => ({ data: [] }),
        messages: async () => ({ data: [] }),
      },
    }
    const manager = new BackgroundManager({
      pluginContext: createPluginContext(client),
      config: { staleTimeoutMs },
      enableParentSessionNotifications: false,
    })
    const task = createRunningTask({
      startedAt: new Date(fixedTime - 45 * 60 * 1000),
      progress: { toolCalls: 3, lastUpdate: new Date(fixedTime - 45 * 60 * 1000) },
    })
    const pollingManager = unsafeTestValue<PollingManager>(manager)
    pollingManager.tasks.set(task.id, task)

    //#when - polling repeats over real elapsed time while the timestamp stays frozen
    for (let i = 0; i < 8; i += 1) {
      await pollingManager.pollRunningTasks()
      nowValue += 60_000
    }

    //#then - a non-advancing timestamp is not liveness, so the task is interrupted
    expect(task.status).toBe("cancelled")
    expect(task.error).toContain("Stale timeout")
    expect(abortCallCount).toBeGreaterThan(0)

    await manager.shutdown()
  })

  test("keeps a busy task running while reported activity keeps advancing", async () => {
    //#given - session metadata advances on every poll, which is genuine progress
    spyOn(globalThis.Date, "now").mockReturnValue(fixedTime)
    let abortCallCount = 0
    let activity = fixedTime - 60_000
    const client = {
      session: {
        status: async () => ({ data: { "ses-active": { type: "busy" } } }),
        get: async () => {
          activity += 1_000
          return { data: { time: { updated: activity } } }
        },
        prompt: async () => ({}),
        promptAsync: async () => ({}),
        abort: async () => {
          abortCallCount += 1
          return {}
        },
        todo: async () => ({ data: [] }),
        messages: async () => ({ data: [] }),
      },
    }
    const manager = new BackgroundManager({
      pluginContext: createPluginContext(client),
      config: { staleTimeoutMs },
      enableParentSessionNotifications: false,
    })
    const task = createRunningTask({
      startedAt: new Date(fixedTime - 45 * 60 * 1000),
      progress: { toolCalls: 3, lastUpdate: new Date(fixedTime - 45 * 60 * 1000) },
    })
    const pollingManager = unsafeTestValue<PollingManager>(manager)
    pollingManager.tasks.set(task.id, task)

    //#when - polling repeats far past the cap while activity genuinely moves
    for (let i = 0; i < 12; i += 1) {
      await pollingManager.pollRunningTasks()
    }

    //#then - a live lane is never killed by the cap
    expect(task.status).toBe("running")
    expect(task.error).toBeUndefined()
    expect(abortCallCount).toBe(0)

    await manager.shutdown()
  })
})
