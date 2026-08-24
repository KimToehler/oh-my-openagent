import { describe, expect, test } from "bun:test"

import type { BackgroundTask } from "../../features/background-agent"
import type { BackgroundOutputClient } from "./clients"
import { formatTaskResult } from "./task-result-format"

function createTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "task-1",
    sessionId: "ses-1",
    parentSessionId: "main-1",
    parentMessageId: "msg-1",
    description: "background task",
    prompt: "do work",
    agent: "test-agent",
    status: "completed",
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: new Date("2026-01-01T00:00:05.000Z"),
    ...overrides,
  }
}

describe("formatTaskResult", () => {
  test("returns assistant session errors instead of masking them as success text", async () => {
    const task = createTask()
    const client: BackgroundOutputClient = {
      session: {
        messages: async () => ({
          data: [
            {
              info: {
                role: "assistant",
                time: { created: 1 },
                error: { data: { message: "Forbidden: Selected provider is forbidden" } },
              },
              parts: [],
            },
          ],
        }),
      },
    }

    const output = await formatTaskResult(task, client)

    expect(output).toContain("Terminal error")
    expect(output).toContain("Forbidden: Selected provider is forbidden")
  })


  test("preserves completed assistant turns when a later assistant message has a session error", async () => {
    const client: BackgroundOutputClient = {
      session: {
        messages: async () => ({
          data: [
            {
              info: { role: "assistant", time: { created: 1 } },
              parts: [{ type: "text", text: "First useful result" }],
            },
            {
              info: { role: "assistant", time: { created: 2 } },
              parts: [{ type: "text", text: "Second useful result" }],
            },
            {
              info: {
                role: "assistant",
                time: { created: 3 },
                error: { data: { message: "Provider failed after progress" } },
              },
              parts: [],
            },
          ],
        }),
      },
    }

    // given
    const output = await formatTaskResult(createTask({ sessionId: "ses-2" }), client)

    // then
    expect(output).toContain("First useful result")
    expect(output).toContain("Second useful result")
    expect(output).toContain("Terminal error: Provider failed after progress")
  })
})
