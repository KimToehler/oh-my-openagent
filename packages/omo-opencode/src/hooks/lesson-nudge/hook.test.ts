import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { ContextCollector } from "../../features/context-injector/collector"
import {
  _resetForTesting,
  setMainSession,
  subagentSessions,
} from "../../features/claude-code-session-state"
import { _resetForTesting as resetLessonNudgeForTesting, createLessonNudgeHook } from "./hook"
import { buildLessonNudgeMessage } from "./message"

const idleEvent = (sessionID: string) => ({
  event: { type: "session.idle", properties: { sessionID } },
})

const deletedEvent = (sessionID: string) => ({
  event: { type: "session.deleted", properties: { sessionID } },
})

afterEach(() => {
  _resetForTesting()
  resetLessonNudgeForTesting()
})

describe("createLessonNudgeHook", () => {
  test("registers once when the same session becomes idle twice", async () => {
    // given
    const collector = new ContextCollector()
    const registerSpy = spyOn(collector, "register")
    const logger = mock(() => {})
    const hook = createLessonNudgeHook(collector, logger)

    // when
    await hook(idleEvent("same-session"))
    await hook(idleEvent("same-session"))

    // then
    expect(registerSpy).toHaveBeenCalledTimes(1)
  })

  test("skips subagent sessions", async () => {
    // given
    const collector = new ContextCollector()
    const registerSpy = spyOn(collector, "register")
    const logger = mock(() => {})
    const hook = createLessonNudgeHook(collector, logger)
    subagentSessions.add("subagent-session")

    // when
    await hook(idleEvent("subagent-session"))

    // then
    expect(registerSpy).toHaveBeenCalledTimes(0)
  })

  test("skips sessions that differ from the main session", async () => {
    // given
    const collector = new ContextCollector()
    const registerSpy = spyOn(collector, "register")
    const logger = mock(() => {})
    const hook = createLessonNudgeHook(collector, logger)
    setMainSession("main-session")

    // when
    await hook(idleEvent("other-session"))

    // then
    expect(registerSpy).toHaveBeenCalledTimes(0)
  })

  test("registers again after the session is deleted", async () => {
    // given
    const collector = new ContextCollector()
    const registerSpy = spyOn(collector, "register")
    const logger = mock(() => {})
    const hook = createLessonNudgeHook(collector, logger)

    // when
    await hook(idleEvent("deleted-session"))
    await hook(deletedEvent("deleted-session"))
    await hook(idleEvent("deleted-session"))

    // then
    expect(registerSpy).toHaveBeenCalledTimes(2)
  })

  test("registers custom lesson-nudge context", async () => {
    // given
    const collector = new ContextCollector()
    const registerSpy = spyOn(collector, "register")
    const logger = mock(() => {})
    const hook = createLessonNudgeHook(collector, logger)

    // when
    await hook(idleEvent("options-session"))

    // then
    expect(registerSpy).toHaveBeenCalledWith("options-session", expect.objectContaining({
      id: "lesson-nudge",
      source: "custom",
      content: buildLessonNudgeMessage(),
      priority: "normal",
    }))
  })

  test("registers when the main session id is undefined", async () => {
    // given
    const collector = new ContextCollector()
    const registerSpy = spyOn(collector, "register")
    const logger = mock(() => {})
    const hook = createLessonNudgeHook(collector, logger)
    setMainSession(undefined)

    // when
    await hook(idleEvent("resumed-session"))

    // then
    expect(registerSpy).toHaveBeenCalledTimes(1)
  })

  test("logs once only when registration succeeds", async () => {
    // given
    const collector = new ContextCollector()
    const logger = mock(() => {})
    const hook = createLessonNudgeHook(collector, logger)
    subagentSessions.add("skipped-subagent")
    setMainSession("registering-session")

    // when
    await hook(idleEvent("skipped-subagent"))
    await hook(idleEvent("skipped-non-main"))
    await hook(idleEvent("registering-session"))
    await hook(idleEvent("registering-session"))

    // then
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("[lesson-nudge] registered nudge", {
      sessionID: "registering-session",
      contentLength: buildLessonNudgeMessage().length,
    })
  })
})
