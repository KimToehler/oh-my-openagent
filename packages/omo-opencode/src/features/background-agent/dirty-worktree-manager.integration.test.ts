/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import type { PluginInput } from "@opencode-ai/plugin"
import { BackgroundManager } from "./manager"
import type { DirtyWorktreeStatus } from "./dirty-worktree"

async function waitForRunningTask(manager: BackgroundManager, taskID: string): Promise<void> {
  const deadlineAt = Date.now() + 1_000
  while (manager.getTask(taskID)?.status !== "running") {
    if (Date.now() > deadlineAt) throw new Error("timed out waiting for running task")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("BackgroundManager dirty worktree completion annotation", () => {
  test("#given unavailable worktree status at launch #when child session completes #then parent notification omits uncommitted file count", async () => {
    //#given
    const directory = tmpdir()
    const client = {
      session: {
        get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, directory } }),
        create: async () => ({ data: { id: "unavailable-child-session" } }),
        promptAsync: async () => ({ data: {} }),
        messages: async () => ({ data: [{ info: { role: "assistant", finish: "end_turn" }, parts: [{ type: "text", text: "done" }] }] }),
        todo: async () => ({ data: [] }),
      },
    }
    const manager = new BackgroundManager({
      pluginContext: { client, directory } as PluginInput,
      enableParentSessionNotifications: false,
      dirtyWorktreeStatusReader: async () => ({ kind: "unavailable" }),
    })
    const task = await manager.launch({
      description: "unavailable task",
      prompt: "work",
      agent: "general",
      parentSessionId: "unavailable-parent-session",
      parentMessageId: "parent-message",
    })

    //#when
    await waitForRunningTask(manager, task.id)
    const runningTask = manager.getTask(task.id)
    if (!runningTask?.startedAt) throw new Error("running task missing start time")
    runningTask.startedAt = new Date(runningTask.startedAt.getTime() - 60_000)
    manager.handleEvent({ type: "session.idle", properties: { sessionID: "unavailable-child-session" } })
    const deadlineAt = Date.now() + 1_000
    while (manager.getTask(task.id)?.status !== "completed") {
      if (Date.now() > deadlineAt) throw new Error("timed out waiting for completed task")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    //#then
    expect(manager.getPendingNotifications("unavailable-parent-session")[0]?.uncommittedFileCount).toBeUndefined()
    await manager.shutdown()
  })

  test("#given a launch baseline and later dirty path #when child session completes #then parent notification carries only new path count", async () => {
    //#given
    const directory = tmpdir()
    const statuses: readonly DirtyWorktreeStatus[] = [
      { kind: "available", paths: new Set(["existing.ts"]) },
      { kind: "available", paths: new Set(["existing.ts", "new.ts"]) },
    ]
    let statusIndex = 0
    const client = {
      session: {
        get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, directory } }),
        create: async () => ({ data: { id: "child-session" } }),
        promptAsync: async () => ({ data: {} }),
        messages: async () => ({ data: [{ info: { role: "assistant", finish: "end_turn" }, parts: [{ type: "text", text: "done" }] }] }),
        todo: async () => ({ data: [] }),
      },
    }
    const manager = new BackgroundManager({
      pluginContext: { client, directory } as PluginInput,
      enableParentSessionNotifications: false,
      dirtyWorktreeStatusReader: async () => statuses[statusIndex++] ?? { kind: "unavailable" },
    })
    const task = await manager.launch({
      description: "dirty task",
      prompt: "work",
      agent: "general",
      parentSessionId: "parent-session",
      parentMessageId: "parent-message",
    })

    //#when
    await waitForRunningTask(manager, task.id)
    const runningTask = manager.getTask(task.id)
    if (!runningTask?.startedAt) throw new Error("running task missing start time")
    runningTask.startedAt = new Date(runningTask.startedAt.getTime() - 60_000)
    manager.handleEvent({ type: "session.idle", properties: { sessionID: "child-session" } })
    const deadlineAt = Date.now() + 1_000
    while (manager.getTask(task.id)?.status !== "completed") {
      if (Date.now() > deadlineAt) throw new Error("timed out waiting for completed task")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    //#then
    expect(manager.getPendingNotifications("parent-session")[0]?.uncommittedFileCount).toBe(1)
    await manager.shutdown()
  })
})
