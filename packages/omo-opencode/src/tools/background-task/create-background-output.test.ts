/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import type { BackgroundTask } from "../../features/background-agent"
import type { BackgroundOutputClient, BackgroundOutputManager } from "./clients"
import { createBackgroundOutput } from "./create-background-output"

const projectDir = "/tmp/subagent-blocked-report"

const toolContext = {
  sessionID: "ses_parent",
  messageID: "msg_parent",
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

function createTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "bg_blocked",
    sessionId: "ses_child",
    parentSessionId: "ses_parent",
    parentMessageId: "msg_parent",
    description: "blocked child",
    prompt: "finish task",
    agent: "test-agent",
    status: "cancelled",
    startedAt: new Date("2026-08-09T10:00:00.000Z"),
    completedAt: new Date("2026-08-09T10:01:00.000Z"),
    ...overrides,
  }
}

function createClient(): BackgroundOutputClient {
  return {
    session: {
      messages: async () => ({ data: [] }),
    },
  }
}

describe("createBackgroundOutput blocked task rendering", () => {
  test("#given a blocked task #when output is requested #then it shows the reason and answer instruction", async () => {
    // given
    const task = createTask({
      blockedAt: new Date("2026-08-09T10:01:00.000Z"),
      blockedReason: "Need deployment target",
    })
    const manager: BackgroundOutputManager = {
      getTask: id => (id === task.id ? task : undefined),
    }
    const outputTool = createBackgroundOutput(manager, createClient())

    // when
    const output = await outputTool.execute({ task_id: task.id }, toolContext)

    // then
    expect(output).toContain("BLOCKED")
    expect(output).toContain("Need deployment target")
    expect(output).toContain('task(task_id="ses_child", prompt="...")')
  })

  test("#given a plain cancelled task #when output is requested #then legacy output stays unchanged", async () => {
    // given
    const task = createTask()
    const manager: BackgroundOutputManager = {
      getTask: id => (id === task.id ? task : undefined),
    }
    const outputTool = createBackgroundOutput(manager, createClient())

    // when
    const output = await outputTool.execute({ task_id: task.id }, toolContext)

    // then
    expect(output).toBe(`# Task Status

| Field | Value |
|-------|-------|
| Task ID | \`bg_blocked\` |
| Description | blocked child |
| Agent | test-agent |
| Status | **cancelled** |
| Duration | 1m 0s |
| Session ID | \`ses_child\` |

## Original Prompt

\`\`\`
finish task
\`\`\``)
  })

  test("#given a blocked task #when block=true is requested #then it returns without polling", async () => {
    // given
    const task = createTask({
      blockedAt: new Date("2026-08-09T10:01:00.000Z"),
      blockedReason: "Need deployment target",
    })
    let lookupCount = 0
    const manager: BackgroundOutputManager = {
      getTask: id => {
        lookupCount += 1
        return id === task.id ? task : undefined
      },
    }
    const outputTool = createBackgroundOutput(manager, createClient())

    // when
    const output = await outputTool.execute(
      { task_id: task.id, block: true, timeout: 600_000 },
      toolContext,
    )

    // then
    expect(lookupCount).toBe(1)
    expect(output).toContain("BLOCKED")
  })
})
