import { beforeEach, describe, expect, it } from "bun:test"

import { _resetForTesting, forgetSession, getOutstandingJobs, recordToolCall } from "./tracker"

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

  it.each([
    ["bracketed completed status with an exit clause", "[background:shell_24ed9238e5ae5551 completed, exit 0]"],
    ["bracketed failed status with an exit clause", "[background:shell_24ed9238e5ae5551 failed, exit 1]"],
    ["bracketed completed status", "[background:shell_24ed9238e5ae5551 completed]"],
    ["line-based completed status", "status: completed\nexit code: 0\n"],
  ])("clears a job for %s", (_label, output) => {
    recordToolCall(detachedStart("shell_24ed9238e5ae5551"))
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { background_action: "status", job_id: "shell_24ed9238e5ae5551" },
      output,
    })

    expect(getOutstandingJobs(SESSION)).toHaveLength(0)
  })

  it("keeps a job outstanding for a bracketed running status", () => {
    recordToolCall(detachedStart("shell_24ed9238e5ae5551"))
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { background_action: "status", job_id: "shell_24ed9238e5ae5551" },
      output: "[background:shell_24ed9238e5ae5551 running]",
    })

    expect(getOutstandingJobs(SESSION)).toHaveLength(1)
  })

  it("does not treat arbitrary bracketed prose before an exit clause as terminal", () => {
    recordToolCall(detachedStart("shell_24ed9238e5ae5551"))
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { background_action: "status", job_id: "shell_24ed9238e5ae5551" },
      output: "[background:shell_24ed9238e5ae5551 arbitrary prose completed, exit 0]",
    })

    expect(getOutstandingJobs(SESSION)).toHaveLength(1)
  })

  it.each([
    ["gradle task failure in the log tail", "status: running\nlast line: Task :compileKotlin FAILED"],
    ["a test count using the word completed", "status: running\n12 tests completed, 3 failed"],
    ["jest output naming failures", "status: running\n> jest\nTests: 2 failed, 5 passed"],
    ["bun output naming failures", "status: running\n 3 pass\n1 fail\nRan 4 tests. 0 failed."],
    ["a download that completed", "status: running\nDownload completed"],
  ])("keeps a running job outstanding when its log tail contains %s", (_label, output) => {
    recordToolCall(detachedStart("shell_3d5ba29a2ac4b779"))
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { background_action: "status", job_id: "shell_3d5ba29a2ac4b779" },
      output,
    })

    expect(getOutstandingJobs(SESSION)).toHaveLength(1)
  })

  // The `^` alternative in STATUS_FIELD_PATTERN anchors at the start of ANY line under the
  // `m` flag. A bare `,` terminator therefore let a log-tail line parse as the status field
  // and retire a job that was still running, which is the fail-open TERMINAL_STATUSES warns
  // about. The terminator requires the `exit` clause so these stay unparseable.
  it.each([
    ["a terminal word plus comma opening the body", "failed, 3 tests\nstatus: running"],
    ["a completed clause before the status header", "completed, moving to next module\nstatus: running"],
    ["an exited clause before the status header", "exited, restarting worker\nstatus: running"],
    ["a cancelled clause before the status header", "cancelled, retrying with backoff\nstatus: running"],
  ])("keeps a running job outstanding despite %s", (_label, output) => {
    recordToolCall(detachedStart("shell_1122334455667788"))
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { background_action: "status", job_id: "shell_1122334455667788" },
      output,
    })

    expect(getOutstandingJobs(SESSION)).toHaveLength(1)
  })

  it("keeps a job outstanding when the status field cannot be parsed at all", () => {
    recordToolCall(detachedStart("shell_1122334455667788"))
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { background_action: "status", job_id: "shell_1122334455667788" },
      output: "some unexpected wording with no status field",
    })

    expect(getOutstandingJobs(SESSION)).toHaveLength(1)
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
      // Deliberately NOT a terminal-status string: this must prove the `cancel` branch
      // retires the job, not that the status parser happened to match the word.
      args: { background_action: "cancel", job_id: "shell_4e6059704ea3df52" },
      output: "ok",
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

  it("does not adopt a job from a poll whose status could not be parsed", () => {
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { background_action: "status", job_id: "shell_99aabbccddeeff00" },
      output: undefined,
    })

    expect(getOutstandingJobs(SESSION)).toEqual([])
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

  it("forgets a session's jobs via the production forgetSession", () => {
    recordToolCall(detachedStart("shell_4eb92e6d6e916b0d"))
    forgetSession(SESSION)

    expect(getOutstandingJobs(SESSION)).toHaveLength(0)
  })

  it("does not resurrect a retired job when a later poll reports it not found", () => {
    recordToolCall(detachedStart("shell_99aabbccddeeff00"))
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { background_action: "status", job_id: "shell_99aabbccddeeff00" },
      output: "status: completed",
    })
    expect(getOutstandingJobs(SESSION)).toHaveLength(0)

    // lean-ctx no longer knows the reaped id; the reply names no terminal status.
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { background_action: "status", job_id: "shell_99aabbccddeeff00" },
      output: "error: job not found",
    })

    expect(getOutstandingJobs(SESSION)).toHaveLength(0)
  })

  it("ignores an unrecognised background_action rather than adopting its job id", () => {
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { background_action: "restart", job_id: "shell_aabbccddeeff0011" },
      output: "whatever",
    })

    expect(getOutstandingJobs(SESSION)).toHaveLength(0)
  })

  it("evicts jobs older than the TTL so an abandoned session cannot grow forever", () => {
    const realNow = Date.now
    try {
      Date.now = () => 1_000_000
      recordToolCall(detachedStart("shell_ccddeeff00112233"))
      expect(getOutstandingJobs(SESSION)).toHaveLength(1)

      // Three hours later a new job arrives; the stale one is pruned on write.
      Date.now = () => 1_000_000 + 3 * 60 * 60 * 1000
      recordToolCall(detachedStart("shell_ddeeff0011223344"))

      expect(getOutstandingJobs(SESSION).map((job) => job.jobId)).toEqual(["shell_ddeeff0011223344"])
    } finally {
      Date.now = realNow
    }
  })

  it("keeps a job tracked when its result was consumed without a terminal poll", () => {
    // The bounded-loop pattern the warning itself teaches: wait on a marker file,
    // then read the result with a non-ctx_shell tool. The tracker never sees a
    // ctx_shell status call, so the job stays outstanding and the hook fires on
    // work the agent already consumed and acted on.
    recordToolCall(detachedStart("shell_1f2e3d4c5b6a7988", "./gradlew build > /tmp/job.log"))

    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { command: 'for i in $(seq 1 50); do grep -q "BUILD SUCCESSFUL" /tmp/job.log && break; sleep 2; done' },
      output: "",
    })
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_read",
      args: { path: "/tmp/job.log" },
      output: "BUILD SUCCESSFUL in 3m 4s",
    })

    // Documents current behavior: consumption by effect does not deregister.
    // The tracker only observes ctx_shell calls, so no signal reaches it here.
    expect(getOutstandingJobs(SESSION).map((job) => job.jobId)).toEqual(["shell_1f2e3d4c5b6a7988"])
  })

  it("caps the number of tracked jobs per session", () => {
    for (let index = 0; index < 80; index += 1) {
      const suffix = index.toString(16).padStart(8, "0")
      recordToolCall(detachedStart(`shell_abcdef${suffix}`))
    }

    expect(getOutstandingJobs(SESSION).length).toBeLessThanOrEqual(64)
  })
})
