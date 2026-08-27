/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import type { BackgroundTaskConfig } from "../../config/schema"
import { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"
import { MIN_IDLE_TIME_MS } from "./constants"
import { MIN_SESSION_GONE_POLLS } from "./session-existence"

function createManager(overrides: Record<string, unknown> = {}, config?: BackgroundTaskConfig): BackgroundManager {
  const client = {
    session: {
      status: async () => ({ data: {} }),
      get: async () => ({ data: { id: "ses-default" } }),
      prompt: async () => ({}),
      promptAsync: async () => ({}),
      abort: async () => ({}),
      todo: async () => ({ data: [] }),
      messages: async () => ({ data: [{ info: { role: "assistant", finish: "end_turn" }, parts: [{ type: "text", text: "done" }] }] }),
      ...overrides,
    },
  }
  const directory = "/tmp"
  const pluginContext: PluginInput = { project: { id: "test", worktree: directory, time: { created: Date.now() } }, directory, worktree: directory, serverUrl: new URL("http://localhost:4096"), $: {} as PluginInput["$"], client: client as PluginInput["client"] }
  return new BackgroundManager({ pluginContext, config, enableParentSessionNotifications: false })
}

function createTask(sessionId: string): BackgroundTask {
  return { id: `task-${sessionId}`, sessionId, parentSessionId: "parent", parentMessageId: "message", description: "task", prompt: "task", agent: "explore", status: "running", startedAt: new Date(Date.now() - MIN_IDLE_TIME_MS - 100), progress: { toolCalls: 0, lastUpdate: new Date(Date.now() - MIN_IDLE_TIME_MS - 100) } }
}

async function poll(manager: BackgroundManager): Promise<void> {
  await manager["pollRunningTasks"]()
}

describe("BackgroundManager completion reasons", () => {
  test("#given a running task whose session reports a terminal status #when the poller completes it #then the task records completionReason terminal-session-status", async () => {
    const manager = createManager({ status: async () => ({ data: { "ses-terminal": { type: "interrupted" } } }) })
    const task = createTask("ses-terminal")
    manager["tasks"].set(task.id, task)
    await poll(manager)
    await manager.shutdown()
    expect(task.completionReason).toBe("terminal-session-status")
  })

  test("#given a running task idle with output and incomplete todos past the grace window #when the poller completes it #then the task records completionReason todo-gate-expired", async () => {
    const fixedNow = new Date("2026-08-27T12:00:00.000Z").getTime()
    const originalDateNow = Date.now
    Date.now = () => fixedNow
    try {
      const manager = createManager({ status: async () => ({ data: { "ses-todo": { type: "idle" } } }), todo: async () => ({ data: [{ content: "unfinished", status: "in_progress", priority: "high" }] }) }, { todoGateGraceMs: 60_000 })
      const task = createTask("ses-todo")
      task.startedAt = new Date(fixedNow - 120_000)
      task.progress = { toolCalls: 0, lastUpdate: new Date(fixedNow - 120_000) }
      task.todoGateFirstObservedAt = new Date(fixedNow - 120_000)
      manager["tasks"].set(task.id, task)
      await poll(manager)
      await manager.shutdown()
      expect(task.completionReason).toBe("todo-gate-expired")
    } finally { Date.now = originalDateNow }
  })

  test("#given a running task whose session reports idle with valid output #when the poller completes it #then the task records completionReason idle-status", async () => {
    const manager = createManager({ status: async () => ({ data: { "ses-idle": { type: "idle" } } }) })
    const task = createTask("ses-idle")
    manager["tasks"].set(task.id, task)
    await poll(manager)
    await manager.shutdown()
    expect(task.completionReason).toBe("idle-status")
  })

  test("#given a running task absent from the status response past the missed-poll threshold #when the poller completes it #then the task records completionReason session-gone", async () => {
    const manager = createManager()
    const task = createTask("ses-gone")
    manager["tasks"].set(task.id, task)
    for (let index = 0; index < MIN_SESSION_GONE_POLLS; index += 1) await poll(manager)
    await manager.shutdown()
    expect(task.completionReason).toBe("session-gone")
  })

  test("#given a running task #when the session.idle event handler completes it #then the task records completionReason session-idle-event", async () => {
    const manager = createManager()
    const task = createTask("ses-event")
    manager["tasks"].set(task.id, task)
    manager.handleEvent({ type: "session.idle", properties: { sessionID: task.sessionId } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await manager.shutdown()
    expect(task.completionReason).toBe("session-idle-event")
  })
})
