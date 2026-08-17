import type { PluginInput } from "@opencode-ai/plugin"
import { beforeEach, describe, expect, it, mock } from "bun:test"

import {
  _resetNudgeStateForTesting,
  createUnpolledShellJobHook,
  NUDGE_COOLDOWN_MS,
} from "./hook"
import { _resetForTesting, recordToolCall } from "./tracker"

const SESSION = "ses_main"

const promptMock = mock(async (_args: unknown) => ({ status: "ok" }) as { status: string })
const settleMock = mock(async () => true)

/** Injected rather than mock.module'd: bun's module mocks are process-global and leak. */
const deps = {
  dispatchPrompt: ((args: unknown) => promptMock(args)) as never,
  isDispatchAccepted: ((result: { status: string }) => result.status === "ok") as never,
  shouldPrompt: (() => settleMock()) as never,
}

const ctx = { client: {}, directory: "/tmp" } as unknown as PluginInput
const idle = { event: { type: "session.idle", properties: { sessionID: SESSION } } }

function startJob(jobId: string, command = "./gradlew test") {
  recordToolCall({
    sessionID: SESSION,
    tool: "lean-ctx_ctx_shell",
    args: { command, run_in_background: true },
    output: `Started background job ${jobId}`,
  })
}

/** The text the hook would send, for asserting on message content. */
function dispatchedText(call: number = 0): string {
  const args = promptMock.mock.calls[call]?.[0] as
    | { input?: { body?: { parts?: { text?: string }[] } } }
    | undefined
  return args?.input?.body?.parts?.[0]?.text ?? ""
}

describe("unpolled shell job hook", () => {
  beforeEach(() => {
    _resetForTesting()
    _resetNudgeStateForTesting()
    promptMock.mockClear()
    settleMock.mockClear()
    promptMock.mockImplementation(async () => ({ status: "ok" }))
    settleMock.mockImplementation(async () => true)
  })

  it("prompts the session when a detached shell job was never polled", async () => {
    startJob("shell_09e11136fc3e37b6", "./gradlew test --tests Foo")

    await createUnpolledShellJobHook(ctx, deps)(idle)

    expect(promptMock).toHaveBeenCalledTimes(1)
    expect(dispatchedText()).toContain("shell_09e11136fc3e37b6")
    expect(dispatchedText()).toContain("./gradlew test --tests Foo")
    expect(dispatchedText()).toContain("does not notify")
  })

  it("dispatches asynchronously so the prompt starts a new turn", async () => {
    startJob("shell_09e11136fc3e37b6")

    await createUnpolledShellJobHook(ctx, deps)(idle)

    const args = promptMock.mock.calls[0]?.[0] as { mode?: string; sessionID?: string }
    expect(args?.mode).toBe("async")
    expect(args?.sessionID).toBe(SESSION)
  })

  it("stays silent when no shell job is outstanding", async () => {
    await createUnpolledShellJobHook(ctx, deps)(idle)

    expect(promptMock).not.toHaveBeenCalled()
  })

  it("stays silent once the job has been polled to completion", async () => {
    startJob("shell_24ed9238e5ae5551")
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { background_action: "status", job_id: "shell_24ed9238e5ae5551" },
      output: "status: completed",
    })

    await createUnpolledShellJobHook(ctx, deps)(idle)

    expect(promptMock).not.toHaveBeenCalled()
  })

  it("still prompts when a poll reported the job as running", async () => {
    startJob("shell_3d5ba29a2ac4b779")
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { background_action: "status", job_id: "shell_3d5ba29a2ac4b779" },
      output: "status: running",
    })

    await createUnpolledShellJobHook(ctx, deps)(idle)

    expect(promptMock).toHaveBeenCalledTimes(1)
    expect(dispatchedText()).toContain("shell_3d5ba29a2ac4b779")
  })

  it("retries on the next idle when the prompt was discarded by semantic dedupe", async () => {
    startJob("shell_5f1c0d2b3a4e5f60")
    const hook = createUnpolledShellJobHook(ctx, {
      ...deps,
      isDispatchAccepted: (() => true) as never,
    })
    promptMock.mockImplementation(async () => ({
      status: "queued",
      queuedBy: "unpolled-shell-job:idle-poll-reminder",
      position: 0,
      coalesceKind: "already-delivered",
    }))

    await hook(idle)
    await hook(idle)

    expect(promptMock).toHaveBeenCalledTimes(2)
  })

  it("lists every outstanding job when several are open", async () => {
    startJob("shell_4e6059704ea3df52", "npm test")
    startJob("shell_4eb92e6d6e916b0d", "./gradlew build")

    await createUnpolledShellJobHook(ctx, deps)(idle)

    expect(dispatchedText()).toContain("shell_4e6059704ea3df52")
    expect(dispatchedText()).toContain("shell_4eb92e6d6e916b0d")
  })

  it("does not prompt when the session became active again", async () => {
    settleMock.mockImplementation(async () => false)
    startJob("shell_50d30ebf447fefcb")

    await createUnpolledShellJobHook(ctx, deps)(idle)

    expect(promptMock).not.toHaveBeenCalled()
  })

  it("ignores events that are not session.idle", async () => {
    startJob("shell_50d30ebf447fefcb")

    await createUnpolledShellJobHook(ctx, deps)({
      event: { type: "session.updated", properties: { sessionID: SESSION } },
    })

    expect(promptMock).not.toHaveBeenCalled()
  })

  it("drops tracked jobs when the session is deleted", async () => {
    startJob("shell_5b2c897b2d02c2bf")

    const hook = createUnpolledShellJobHook(ctx, deps)
    await hook({ event: { type: "session.deleted", properties: { sessionID: SESSION } } })
    await hook(idle)

    expect(promptMock).not.toHaveBeenCalled()
  })

  it("does not re-prompt within the cooldown window", async () => {
    startJob("shell_631191c09fa8d271")
    let clock = 1_000_000
    const hook = createUnpolledShellJobHook(ctx, { ...deps, now: () => clock })

    await hook(idle)
    clock += NUDGE_COOLDOWN_MS - 1
    await hook(idle)

    expect(promptMock).toHaveBeenCalledTimes(1)
  })

  it("keeps prompting after the cooldown while the job is still outstanding", async () => {
    startJob("shell_631191c09fa8d271")
    let clock = 1_000_000
    const hook = createUnpolledShellJobHook(ctx, { ...deps, now: () => clock })

    await hook(idle)
    clock += NUDGE_COOLDOWN_MS + 1
    await hook(idle)

    expect(promptMock).toHaveBeenCalledTimes(2)
    expect(dispatchedText(1)).toContain("shell_631191c09fa8d271")
  })

  it("does not record a cooldown when the dispatch was rejected, so the next idle retries", async () => {
    promptMock.mockImplementation(async () => ({ status: "failed" }))
    startJob("shell_0e430bdc6c9ad516")
    const hook = createUnpolledShellJobHook(ctx, { ...deps, now: () => 1_000_000 })

    await hook(idle)
    await hook(idle)

    expect(promptMock).toHaveBeenCalledTimes(2)
  })
})
