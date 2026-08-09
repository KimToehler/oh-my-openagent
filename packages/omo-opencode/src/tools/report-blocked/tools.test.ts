const { describe, expect, mock, test } = require("bun:test")

import type { BackgroundTask } from "../../features/background-agent"
import { createReportBlockedTool } from "./tools"

const toolContext = {
  sessionID: "ses_child",
  messageID: "msg_child",
  agent: "sisyphus-junior",
  abort: new AbortController().signal,
}

function createTask(): BackgroundTask {
  return {
    id: "task_child",
    sessionId: "ses_child",
    parentSessionId: "ses_parent",
    parentMessageId: "msg_parent",
    description: "Blocked child",
    prompt: "Complete work",
    agent: "sisyphus-junior",
    status: "running",
  }
}

describe("#given a background subagent task", () => {
  test("#when it reports blocked #then the parent is notified before the child is parked", async () => {
    // given
    const task = createTask()
    const calls: string[] = []
    const findBySession = mock(() => task)
    const notifyBlockedTask = mock(async () => {
      calls.push("notify")
    })
    const cancelTask = mock(async () => {
      calls.push("cancel")
      return true
    })
    const reportBlocked = createReportBlockedTool({ findBySession, notifyBlockedTask, cancelTask })

    // when
    const result = await reportBlocked.execute(
      { reason: "Provider requests time out", needs: "Choose another provider" },
      toolContext,
    )

    // then
    expect(task.blockedAt).toBeInstanceOf(Date)
    expect(task.blockedReason).toContain("Provider requests time out")
    expect(task.blockedReason).toContain("Choose another provider")
    expect(calls).toEqual(["notify", "cancel"])
    expect(notifyBlockedTask).toHaveBeenCalledWith("task_child")
    expect(cancelTask).toHaveBeenCalledWith("task_child", {
      source: "report_blocked",
      reason: task.blockedReason,
      abortSession: true,
      skipNotification: true,
    })
    expect(result).toContain("parked")
  })

  test("#when parking fails twice #then each attempt re-notifies and reports the current status", async () => {
    // given
    const task = createTask()
    const notifyBlockedTask = mock(async () => {})
    const cancelTask = mock(async () => false)
    const reportBlocked = createReportBlockedTool({
      findBySession: mock(() => task),
      notifyBlockedTask,
      cancelTask,
    })

    // when
    const firstResult = await reportBlocked.execute(
      { reason: "Missing credentials", needs: "Provide sandbox credentials" },
      toolContext,
    )
    task.status = "cancelled"
    const secondResult = await reportBlocked.execute(
      { reason: "Missing credentials", needs: "Provide sandbox credentials" },
      toolContext,
    )

    // then
    expect(notifyBlockedTask).toHaveBeenCalledTimes(2)
    expect(firstResult).toContain("parent was notified")
    expect(firstResult).toContain("failed to park")
    expect(firstResult).toContain("Current task status: running")
    expect(secondResult).toContain("Current task status: cancelled")
  })
})

describe("#given an empty blocked report", () => {
  test("#when parsing tool arguments #then empty reason and needs are rejected", () => {
    // given
    const reportBlocked = createReportBlockedTool({
      findBySession: mock(() => createTask()),
      notifyBlockedTask: mock(async () => {}),
      cancelTask: mock(async () => true),
    })

    // when
    const reason = reportBlocked.args.reason.safeParse("")
    const needs = reportBlocked.args.needs.safeParse("")

    // then
    expect(reason.success).toBe(false)
    expect(needs.success).toBe(false)
  })
})

describe("#given a session without a background task", () => {
  test("#when it reports blocked #then it returns an error without trying to park", async () => {
    // given
    const cancelTask = mock(async () => true)
    const reportBlocked = createReportBlockedTool({
      findBySession: mock(() => undefined),
      notifyBlockedTask: mock(async () => {}),
      cancelTask,
    })

    // when
    const result = await reportBlocked.execute(
      { reason: "No task", needs: "A task" },
      toolContext,
    )

    // then
    expect(result).toContain("not a background subagent session")
    expect(cancelTask).not.toHaveBeenCalled()
  })
})
