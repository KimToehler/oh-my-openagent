import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import { BackgroundManager } from "../../features/background-agent/manager"
import { clearBackgroundTaskRegistryForTesting } from "../../features/background-agent/task-registry"
import type { BackgroundTask } from "../../features/background-agent/types"
import { releaseAllPromptAsyncReservationsForTesting } from "../../hooks/shared/prompt-async-gate"
import type { BackgroundOutputClient } from "./clients"
import { createBackgroundOutput } from "./create-background-output"

const projectDir = tmpdir()

const mockContext = {
  sessionID: "test-session",
  messageID: "test-message",
  agent: "test-agent",
  directory: projectDir,
  worktree: projectDir,
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
  $: () => {
    const result = { stdout: Buffer.from(""), stderr: Buffer.from(""), exitCode: 0 }
    const promise = Promise.resolve(result) as Promise<typeof result> & {
      quiet: () => Promise<typeof result>
      nothrow: () => typeof promise
    }
    promise.quiet = () => promise
    promise.nothrow = () => promise
    return promise
  },
} as ToolContext

const constructedManagers: BackgroundManager[] = []

beforeEach(() => {
  clearBackgroundTaskRegistryForTesting()
})

afterEach(() => {
  for (const manager of constructedManagers) {
    manager.shutdown()
  }
  constructedManagers.length = 0
  releaseAllPromptAsyncReservationsForTesting()
})

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
  const ctx: PluginInput = {
    client: client as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory: tmpdir(),
    worktree: tmpdir(),
    serverUrl: new URL("http://localhost"),
    $: {} as PluginInput["$"],
  }

  const manager = new BackgroundManager({
    pluginContext: ctx,
    config: undefined,
    enableParentSessionNotifications: false,
  })
  constructedManagers.push(manager)
  return manager
}

function createCompletedTask(id: string): BackgroundTask {
  return {
    id,
    sessionId: "ses_cross_instance",
    parentSessionId: "ses_parent",
    parentMessageId: "parent-message-id",
    description: "cross-instance lookup task",
    prompt: `Prompt for ${id}`,
    agent: "test-agent",
    status: "completed",
    startedAt: new Date("2026-08-07T00:00:00.000Z"),
    completedAt: new Date("2026-08-07T00:01:00.000Z"),
  }
}

function addTaskToManager(manager: BackgroundManager, task: BackgroundTask): void {
  const addTask = Reflect.get(manager, "addTask")
  if (typeof addTask !== "function") {
    throw new Error("BackgroundManager.addTask is not accessible via reflection")
  }
  addTask.call(manager, task)
}

function createOutputClient(): BackgroundOutputClient {
  return {
    session: {
      messages: async () => ({
        data: [
          {
            id: "m1",
            info: { role: "assistant", time: "2026-08-07T00:00:30.000Z" },
            parts: [{ type: "text", text: "cross-instance result" }],
          },
        ],
      }),
    },
  }
}

describe("createBackgroundOutput cross-instance lookup", () => {
  describe("#given a task launched on manager A", () => {
    describe("#when background_output is bound to a separate manager B in the same realm", () => {
      test("#then the global registry still resolves the task", async () => {
        const managerA = createManager()
        const managerB = createManager()
        const task = createCompletedTask("bg_cross_instance")
        addTaskToManager(managerA, task)
        expect(managerB.getTask(task.id)?.id).toBe(task.id)

        const outputTool = createBackgroundOutput(managerB, createOutputClient())
        const output = await outputTool.execute({ task_id: task.id }, mockContext)

        expect(output).not.toContain("Task not found")
        expect(output).toContain("cross-instance result")
      })
    })
  })

  describe("#given the global background task registry is empty (simulating a foreign realm)", () => {
    describe("#when background_output looks up a bg id", () => {
      test("#then it returns the not-found message", async () => {
        const manager = createManager()
        clearBackgroundTaskRegistryForTesting()

        const outputTool = createBackgroundOutput(manager, createOutputClient())
        const output = await outputTool.execute({ task_id: "bg_missing_realm" }, mockContext)

        expect(output).toBe("Task not found: bg_missing_realm")
      })
    })
  })
})
