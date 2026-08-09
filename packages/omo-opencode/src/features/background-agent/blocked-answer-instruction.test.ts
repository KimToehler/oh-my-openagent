import { describe, expect, test } from "bun:test"
import { buildBlockedAnswerInstruction } from "./blocked-answer-instruction"

describe("buildBlockedAnswerInstruction", () => {
  describe("#given a valid session ID", () => {
    test("#when building instruction #then it returns actionable text with exact invocation", () => {
      // given
      const sessionId = "ses_child_blocked_123"

      // when
      const instruction = buildBlockedAnswerInstruction(sessionId)

      // then
      expect(instruction).toContain("**Child needs your answer:**")
      expect(instruction).toContain("Reply with the requested information using this exact invocation:")
      expect(instruction).toContain(`task(task_id="${sessionId}", prompt="<your answer>")`)
    })
  })

  describe("#given an unknown session ID", () => {
    test("#when building instruction #then it still includes the placeholder", () => {
      // given
      const sessionId = "unknown-session"

      // when
      const instruction = buildBlockedAnswerInstruction(sessionId)

      // then
      expect(instruction).toContain(`task(task_id="${sessionId}", prompt="<your answer>")`)
    })
  })

  describe("#given two calls with different session IDs", () => {
    test("#when building instructions #then each has the correct session ID", () => {
      // given
      const sessionId1 = "ses_1"
      const sessionId2 = "ses_2"

      // when
      const instruction1 = buildBlockedAnswerInstruction(sessionId1)
      const instruction2 = buildBlockedAnswerInstruction(sessionId2)

      // then
      expect(instruction1).toContain(`task(task_id="${sessionId1}",`)
      expect(instruction2).toContain(`task(task_id="${sessionId2}",`)
      expect(instruction1).not.toContain(sessionId2)
      expect(instruction2).not.toContain(sessionId1)
    })
  })
})
