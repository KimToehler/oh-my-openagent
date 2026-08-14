import { describe, expect, test } from "bun:test"

import { buildLessonNudgeMessage } from "./message"

describe("buildLessonNudgeMessage", () => {
  test("#given a correction #when nudge is built #then it directs lesson recording for future sessions", () => {
    // given / when
    const message = buildLessonNudgeMessage()

    // then
    expect(message).toContain("record_lesson")
    expect(message).toContain("future sessions")
    expect(message).toContain("globs")
    expect(message).toContain("evidence citation")
    expect(message).not.toMatch(/[\u2014\u2013]/)
    expect(message.length).toBeLessThanOrEqual(400)
  })
})
