import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { isTaskBlocked } from "./blocked-state"
import type { BackgroundTask } from "./types"

describe("isTaskBlocked", () => {
  test("#given a bare task #when blockedAt is set #then blocked state changes from false to true", () => {
    // given
    const task: BackgroundTask = {
      id: "task-1",
      parentSessionId: "parent-session",
      parentMessageId: "parent-message",
      description: "test task",
      prompt: "test prompt",
      agent: "test-agent",
      status: "running",
    }

    // when / then
    expect(isTaskBlocked(task)).toBe(false)
    task.blockedAt = new Date()
    expect(isTaskBlocked(task)).toBe(true)
  })
})

describe("BackgroundTaskStatus", () => {
  test("#given the status definition #when its members are inspected #then it retains exactly the six lifecycle statuses", () => {
    // given
    const source = readFileSync(new URL("./types.ts", import.meta.url), "utf8")
    const declaration = source.match(/export type BackgroundTaskStatus\s*=([\s\S]*?)\n\s*export interface ToolCallWindow/)
    const actualStatuses = declaration?.[1].match(/"[^"]+"/g) ?? []
    const expectedStatuses = ["pending", "running", "completed", "error", "cancelled", "interrupt"].map(
      status => `"${status}"`,
    )

    // when
    const statusChanged = JSON.stringify(actualStatuses) !== JSON.stringify(expectedStatuses)

    // then
    if (statusChanged) {
      throw new Error(
        `BackgroundTaskStatus must keep exactly its 6 lifecycle members; blocked is orthogonal metadata, not a status. Expected ${JSON.stringify(expectedStatuses)}, received ${JSON.stringify(actualStatuses)}`,
      )
    }
  })
})
