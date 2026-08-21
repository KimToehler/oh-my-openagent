import { describe, expect, test } from "bun:test"
import type { BackgroundTask } from "../../features/background-agent"
import { formatTaskStatus } from "./task-status-format"

function runningTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  const now = Date.now()
  return {
    id: "bg_status",
    sessionId: "ses_child",
    parentSessionId: "ses_parent",
    parentMessageId: "msg_parent",
    description: "research task",
    prompt: "do the research",
    agent: "explore",
    status: "running",
    startedAt: new Date(now - 20 * 60_000),
    progress: { toolCalls: 5, lastUpdate: new Date(now - 30_000) },
    ...overrides,
  } as BackgroundTask
}

describe("formatTaskStatus session-activity honesty", () => {
  test("#given a running task with recent activity #when formatted #then it reports the reassuring note unchanged", () => {
    // given
    const task = runningTask()

    // when
    const output = formatTaskStatus(task)

    // then
    expect(output).toContain("No need to wait explicitly")
    expect(output).not.toContain("No session activity")
  })

  test("#given a running task silent past the stale threshold #when formatted #then it discloses the silence instead of reassuring", () => {
    // given
    const task = runningTask({
      progress: { toolCalls: 5, lastUpdate: new Date(Date.now() - 46 * 60_000) },
    } as Partial<BackgroundTask>)

    // when
    const output = formatTaskStatus(task)

    // then
    expect(output).toContain("No session activity")
    expect(output).not.toContain("No need to wait explicitly")
  })

  test("#given a running task the poller has not seen in the status registry #when formatted #then it discloses the missed polls", () => {
    // given
    const task = runningTask({ consecutiveMissedPolls: 3 } as Partial<BackgroundTask>)

    // when
    const output = formatTaskStatus(task)

    // then
    expect(output).toContain("not present in the session registry")
  })

  test("#given a silent running task #when formatted #then the reported silence matches the last activity age", () => {
    // given
    const task = runningTask({
      progress: { toolCalls: 5, lastUpdate: new Date(Date.now() - 47 * 60_000) },
    } as Partial<BackgroundTask>)

    // when
    const output = formatTaskStatus(task)

    // then
    expect(output).toMatch(/No session activity for 4[67]m/)
  })

  test("#given a completed task #when formatted #then no activity warning is added", () => {
    // given
    const task = runningTask({
      status: "completed",
      completedAt: new Date(),
      progress: { toolCalls: 5, lastUpdate: new Date(Date.now() - 90 * 60_000) },
    } as Partial<BackgroundTask>)

    // when
    const output = formatTaskStatus(task)

    // then
    expect(output).not.toContain("No session activity")
  })

  test("#given a blocked task silent for a long time #when formatted #then the blocked notice wins over the activity warning", () => {
    // given
    const task = runningTask({
      blockedAt: new Date(Date.now() - 50 * 60_000),
      blockedReason: "Need parent input",
      progress: { toolCalls: 5, lastUpdate: new Date(Date.now() - 50 * 60_000) },
    } as Partial<BackgroundTask>)

    // when
    const output = formatTaskStatus(task)

    // then
    expect(output).toContain("BLOCKED")
    expect(output).not.toContain("No session activity")
  })
})
