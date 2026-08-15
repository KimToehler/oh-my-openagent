import { beforeEach, describe, expect, it } from "bun:test"

import type { ContextCollector } from "../../features/context-injector/collector"

import { _resetWarnedForTesting, createUnpolledShellJobHook } from "./hook"
import { _resetForTesting, recordToolCall } from "./tracker"

const SESSION = "ses_main"

type Registered = { sessionID: string; id: string; content: string }

function fakeCollector(): { collector: ContextCollector; registered: Registered[] } {
  const registered: Registered[] = []
  const collector = {
    register(sessionID: string, options: { id: string; content: string }) {
      registered.push({ sessionID, id: options.id, content: options.content })
    },
  } as unknown as ContextCollector
  return { collector, registered }
}

const idle = { event: { type: "session.idle", properties: { sessionID: SESSION } } }

function startJob(jobId: string, command = "./gradlew test") {
  recordToolCall({
    sessionID: SESSION,
    tool: "lean-ctx_ctx_shell",
    args: { command, run_in_background: true },
    output: `Started background job ${jobId}`,
  })
}

describe("unpolled shell job hook", () => {
  beforeEach(() => {
    _resetForTesting()
    _resetWarnedForTesting()
  })

  it("warns at idle when a detached shell job was never polled", async () => {
    const { collector, registered } = fakeCollector()
    startJob("shell_09e11136fc3e37b6", "./gradlew test --tests Foo")

    await createUnpolledShellJobHook(collector, () => {})(idle)

    expect(registered).toHaveLength(1)
    expect(registered[0]?.sessionID).toBe(SESSION)
    expect(registered[0]?.id).toBe("unpolled-shell-job")
    expect(registered[0]?.content).toContain("shell_09e11136fc3e37b6")
    expect(registered[0]?.content).toContain("./gradlew test --tests Foo")
    expect(registered[0]?.content).toContain("does not notify")
  })

  it("stays silent when no shell job is outstanding", async () => {
    const { collector, registered } = fakeCollector()

    await createUnpolledShellJobHook(collector, () => {})(idle)

    expect(registered).toHaveLength(0)
  })

  it("stays silent once the job has been polled to completion", async () => {
    const { collector, registered } = fakeCollector()
    startJob("shell_24ed9238e5ae5551")
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { background_action: "status", job_id: "shell_24ed9238e5ae5551" },
      output: "status: completed",
    })

    await createUnpolledShellJobHook(collector, () => {})(idle)

    expect(registered).toHaveLength(0)
  })

  it("still warns when a poll reported the job as running", async () => {
    const { collector, registered } = fakeCollector()
    startJob("shell_3d5ba29a2ac4b779")
    recordToolCall({
      sessionID: SESSION,
      tool: "lean-ctx_ctx_shell",
      args: { background_action: "status", job_id: "shell_3d5ba29a2ac4b779" },
      output: "status: running",
    })

    await createUnpolledShellJobHook(collector, () => {})(idle)

    expect(registered).toHaveLength(1)
    expect(registered[0]?.content).toContain("shell_3d5ba29a2ac4b779")
  })

  it("lists every outstanding job when several are open", async () => {
    const { collector, registered } = fakeCollector()
    startJob("shell_4e6059704ea3df52", "npm test")
    startJob("shell_4eb92e6d6e916b0d", "./gradlew build")

    await createUnpolledShellJobHook(collector, () => {})(idle)

    expect(registered).toHaveLength(1)
    expect(registered[0]?.content).toContain("shell_4e6059704ea3df52")
    expect(registered[0]?.content).toContain("shell_4eb92e6d6e916b0d")
  })

  it("ignores events that are not session.idle", async () => {
    const { collector, registered } = fakeCollector()
    startJob("shell_50d30ebf447fefcb")

    await createUnpolledShellJobHook(collector, () => {})({
      event: { type: "session.updated", properties: { sessionID: SESSION } },
    })

    expect(registered).toHaveLength(0)
  })

  it("drops tracked jobs when the session is deleted", async () => {
    const { collector, registered } = fakeCollector()
    startJob("shell_5b2c897b2d02c2bf")

    const hook = createUnpolledShellJobHook(collector, () => {})
    await hook({ event: { type: "session.deleted", properties: { sessionID: SESSION } } })
    await hook(idle)

    expect(registered).toHaveLength(0)
  })

  it("warns only once per job so repeated idles do not spam", async () => {
    const { collector, registered } = fakeCollector()
    startJob("shell_631191c09fa8d271")

    const hook = createUnpolledShellJobHook(collector, () => {})
    await hook(idle)
    await hook(idle)

    expect(registered).toHaveLength(1)
  })

  it("warns again when a new job appears after an earlier warning", async () => {
    const { collector, registered } = fakeCollector()
    startJob("shell_631191c09fa8d271")

    const hook = createUnpolledShellJobHook(collector, () => {})
    await hook(idle)
    startJob("shell_0e430bdc6c9ad516")
    await hook(idle)

    expect(registered).toHaveLength(2)
    expect(registered[1]?.content).toContain("shell_0e430bdc6c9ad516")
  })
})
