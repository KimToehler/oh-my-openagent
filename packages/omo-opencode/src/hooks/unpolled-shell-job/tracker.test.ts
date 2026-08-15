import { beforeEach, describe, expect, it } from "bun:test"

import { _resetForTesting, getOutstandingJobs, recordToolCall } from "./tracker"

const SESSION = "ses_test"

const detachedStart = (jobId: string, command = "./gradlew test") => ({
  sessionID: SESSION,
  tool: "lean-ctx_ctx_shell",
  args: { command, run_in_background: true },
  output: `Started background job ${jobId}\nPoll with background_action="status".`,
})

describe("unpolled shell job tracker", () => {
  beforeEach(() => {
    _resetForTesting()
  })

  it("registers a job id parsed from a detached ctx_shell result", () => {
    recordToolCall(detachedStart("shell_09e11136fc3e37b6"))

    const outstanding = getOutstandingJobs(SESSION)

    expect(outstanding).toHaveLength(1)
    expect(outstanding[0]?.jobId).toBe("shell_09e11136fc3e37b6")
    expect(outstanding[0]?.command).toBe("./gradlew test")
  })

  it("ignores foreground ctx_shell calls", () => {
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { command: "ls" },
      output: "a\nb\n",
    })

    expect(getOutstandingJobs(SESSION)).toHaveLength(0)
  })

  it("ignores tools that are not ctx_shell", () => {
    recordToolCall({
      sessionID: SESSION,
      tool: "bash",
      args: { command: "ls", run_in_background: true },
      output: "shell_deadbeefdeadbeef",
    })

    expect(getOutstandingJobs(SESSION)).toHaveLength(0)
  })

  it("clears a job once a status poll reports it completed", () => {
    recordToolCall(detachedStart("shell_24ed9238e5ae5551"))
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { background_action: "status", job_id: "shell_24ed9238e5ae5551" },
      output: 'status: completed\nexit code: 0\n',
    })

    expect(getOutstandingJobs(SESSION)).toHaveLength(0)
  })

  it("keeps a job outstanding while a poll still reports it running", () => {
    recordToolCall(detachedStart("shell_3d5ba29a2ac4b779"))
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { background_action: "status", job_id: "shell_3d5ba29a2ac4b779" },
      output: "status: running\n",
    })

    expect(getOutstandingJobs(SESSION)).toHaveLength(1)
  })

  it("clears a job when it is cancelled", () => {
    recordToolCall(detachedStart("shell_4e6059704ea3df52"))
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { background_action: "cancel", job_id: "shell_4e6059704ea3df52" },
      output: "cancelled",
    })

    expect(getOutstandingJobs(SESSION)).toHaveLength(0)
  })

  it("tracks jobs per session and does not leak across sessions", () => {
    recordToolCall(detachedStart("shell_50d30ebf447fefcb"))
    recordToolCall({
      sessionID: "ses_other",
      tool: "lean-ctx_ctx_shell",
      args: { command: "sleep 1", run_in_background: true },
      output: "Started background job shell_5b2c897b2d02c2bf",
    })

    expect(getOutstandingJobs(SESSION).map((job) => job.jobId)).toEqual(["shell_50d30ebf447fefcb"])
    expect(getOutstandingJobs("ses_other").map((job) => job.jobId)).toEqual(["shell_5b2c897b2d02c2bf"])
  })

  it("does not double-register the same job id", () => {
    recordToolCall(detachedStart("shell_631191c09fa8d271"))
    recordToolCall(detachedStart("shell_631191c09fa8d271"))

    expect(getOutstandingJobs(SESSION)).toHaveLength(1)
  })

  it("adopts a job seen only via a running poll, when the start message was not parseable", () => {
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { command: "./gradlew test", run_in_background: true },
      output: "Kicked off in the background. (wording lean-ctx could change)",
    })
    expect(getOutstandingJobs(SESSION)).toHaveLength(0)

    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { background_action: "status", job_id: "shell_77aabbccddeeff00" },
      output: "status: running",
    })

    expect(getOutstandingJobs(SESSION).map((job) => job.jobId)).toEqual(["shell_77aabbccddeeff00"])
  })

  it("does not resurrect a job that a terminal poll just cleared", () => {
    recordToolCall(detachedStart("shell_88aabbccddeeff00"))
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { background_action: "status", job_id: "shell_88aabbccddeeff00" },
      output: "status: completed",
    })
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { background_action: "status", job_id: "shell_88aabbccddeeff00" },
      output: "status: completed",
    })

    expect(getOutstandingJobs(SESSION)).toHaveLength(0)
  })

  it("forgets a session's jobs when the session is cleared", () => {
    recordToolCall(detachedStart("shell_4eb92e6d6e916b0d"))
    _resetForTesting(SESSION)

    expect(getOutstandingJobs(SESSION)).toHaveLength(0)
  })
})
