// allow: SIZE_OK - transcript pairing tests cover one scanner contract (anchored id-to-session recovery) with shared fixtures; future additions should split by matcher shape.

import { describe, expect, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import type { BackgroundTask } from "../../features/background-agent/types"
import type { BackgroundOutputClient, BackgroundOutputMessage } from "./clients"
import { formatFullSession } from "./full-session-format"
import { findSessionIdInParentTranscript } from "./parent-transcript-pairing"

const PARENT_SESSION_ID = "ses_parent"

function clientWithMessages(messages: BackgroundOutputMessage[]): BackgroundOutputClient {
  return {
    session: {
      messages: async () => ({ data: messages }),
    },
  }
}

function textMessage(id: string, ...texts: string[]): BackgroundOutputMessage {
  return {
    id,
    info: { role: "assistant", time: `2026-08-07T00:00:0${id.length % 10}.000Z` },
    parts: texts.map((text) => ({ type: "text", text })),
  }
}

function launchRecord(taskId: string, sessionId: string): string {
  return [
    "Background task launched successfully.",
    "",
    `Task ID: ${taskId}`,
    `Session ID: ${sessionId}`,
    "Description: some task",
    "Agent: explore",
    "Status: running",
  ].join("\n")
}

describe("findSessionIdInParentTranscript", () => {
  describe("#given three launch records inside ONE chunk", () => {
    const chunk = [launchRecord("bg_first", "ses_first"), launchRecord("bg_second", "ses_second"), launchRecord("bg_third", "ses_third")].join("\n\n")

    test("#when the third task is requested #then it resolves to the third session, never the first", async () => {
      const client = clientWithMessages([textMessage("m1", chunk)])

      const sessionId = await findSessionIdInParentTranscript(client, PARENT_SESSION_ID, "bg_third")

      expect(sessionId).toBe("ses_third")
      expect(sessionId).not.toBe("ses_first")
    })

    test("#when the first task is requested #then it resolves to the first session", async () => {
      const client = clientWithMessages([textMessage("m1", chunk)])

      const sessionId = await findSessionIdInParentTranscript(client, PARENT_SESSION_ID, "bg_first")

      expect(sessionId).toBe("ses_first")
    })
  })

  describe("#given a child transcript that itself launched a background task (nested tool_result)", () => {
    async function buildNestedChunk(): Promise<string> {
      const outerTask: BackgroundTask = {
        id: "bg_outer",
        sessionId: "ses_outer",
        parentSessionId: PARENT_SESSION_ID,
        parentMessageId: "m-parent",
        description: "outer task",
        prompt: "outer prompt",
        agent: "explore",
        status: "completed",
      }
      const childClient = clientWithMessages([
        {
          id: "m-child",
          info: { role: "assistant", time: "2026-08-07T00:00:30.000Z" },
          parts: [
            { type: "tool_result", content: launchRecord("bg_inner", "ses_inner") },
            { type: "text", text: "outer child finished" },
          ],
        },
      ])
      return formatFullSession(outerTask, childClient, {
        includeThinking: false,
        includeToolResults: true,
      })
    }

    test("#when the INNER task is requested #then it resolves to the inner session, not the outer header session", async () => {
      const nestedChunk = await buildNestedChunk()
      expect(nestedChunk).toContain("Session ID: ses_outer")
      expect(nestedChunk).toContain("Session ID: ses_inner")
      const client = clientWithMessages([textMessage("m1", nestedChunk)])

      const sessionId = await findSessionIdInParentTranscript(client, PARENT_SESSION_ID, "bg_inner")

      expect(sessionId).toBe("ses_inner")
    })

    test("#when the OUTER task is requested #then it resolves to the outer session", async () => {
      const nestedChunk = await buildNestedChunk()
      const client = clientWithMessages([textMessage("m1", nestedChunk)])

      const sessionId = await findSessionIdInParentTranscript(client, PARENT_SESSION_ID, "bg_outer")

      expect(sessionId).toBe("ses_outer")
    })
  })

  describe("#given a chunk that mentions the task id in prose with an unrelated Session ID elsewhere", () => {
    test("#when that task is requested #then no false pairing is made", async () => {
      const chunk = [
        launchRecord("bg_p1", "ses_p1"),
        "",
        "Later prose: the request for Task ID: bg_p2 could not be completed and no session was recorded for it.",
      ].join("\n")
      const client = clientWithMessages([textMessage("m1", chunk)])

      const sessionId = await findSessionIdInParentTranscript(client, PARENT_SESSION_ID, "bg_p2")

      expect(sessionId).toBeUndefined()
    })
  })

  describe("#given a metadata block that conflicts with launch text in the same chunk", () => {
    test("#when the task is requested #then the metadata block wins", async () => {
      const chunk = [
        launchRecord("bg_conflict", "ses_from_launch"),
        "",
        "<task_metadata>",
        "background_task_id: bg_conflict",
        "session_id: ses_from_metadata",
        "</task_metadata>",
      ].join("\n")
      const client = clientWithMessages([textMessage("m1", chunk)])

      const sessionId = await findSessionIdInParentTranscript(client, PARENT_SESSION_ID, "bg_conflict")

      expect(sessionId).toBe("ses_from_metadata")
    })
  })

  describe("#given multiple metadata blocks in one chunk", () => {
    test("#when the requested id lives in the SECOND block #then that block's session is returned", async () => {
      const chunk = [
        "<task_metadata>",
        "background_task_id: bg_meta_one",
        "session_id: ses_meta_one",
        "</task_metadata>",
        "<task_metadata>",
        "background_task_id: bg_meta_two",
        "session_id: ses_meta_two",
        "</task_metadata>",
      ].join("\n")
      const client = clientWithMessages([textMessage("m1", chunk)])

      const sessionId = await findSessionIdInParentTranscript(client, PARENT_SESSION_ID, "bg_meta_two")

      expect(sessionId).toBe("ses_meta_two")
    })
  })

  describe("#given launch records in SEPARATE message parts", () => {
    test("#when the second task is requested #then its own part provides the pairing", async () => {
      const client = clientWithMessages([
        textMessage("m1", launchRecord("bg_c1", "ses_c1"), launchRecord("bg_c2", "ses_c2")),
      ])

      const sessionId = await findSessionIdInParentTranscript(client, PARENT_SESSION_ID, "bg_c2")

      expect(sessionId).toBe("ses_c2")
    })
  })

  describe("#given a later message that re-pairs the same task id", () => {
    test("#when the task is requested #then the later message wins", async () => {
      const client = clientWithMessages([
        textMessage("m1", launchRecord("bg_retry", "ses_old_attempt")),
        textMessage("m2", launchRecord("bg_retry", "ses_new_attempt")),
      ])

      const sessionId = await findSessionIdInParentTranscript(client, PARENT_SESSION_ID, "bg_retry")

      expect(sessionId).toBe("ses_new_attempt")
    })
  })

  describe("#given task ids that are prefixes of each other", () => {
    test("#when the SHORT id is requested but only the LONG id is recorded #then no pairing is made", async () => {
      const client = clientWithMessages([textMessage("m1", launchRecord("bg_abc123", "ses_long"))])

      const sessionId = await findSessionIdInParentTranscript(client, PARENT_SESSION_ID, "bg_abc")

      expect(sessionId).toBeUndefined()
    })

    test("#when the LONG id is requested but only the SHORT id is recorded #then no pairing is made", async () => {
      const client = clientWithMessages([textMessage("m1", launchRecord("bg_abc", "ses_short"))])

      const sessionId = await findSessionIdInParentTranscript(client, PARENT_SESSION_ID, "bg_abc123")

      expect(sessionId).toBeUndefined()
    })

    test("#when both are recorded #then each resolves to its own session", async () => {
      const client = clientWithMessages([
        textMessage("m1", launchRecord("bg_abc", "ses_short"), launchRecord("bg_abc123", "ses_long")),
      ])

      expect(await findSessionIdInParentTranscript(client, PARENT_SESSION_ID, "bg_abc")).toBe("ses_short")
      expect(await findSessionIdInParentTranscript(client, PARENT_SESSION_ID, "bg_abc123")).toBe("ses_long")
    })
  })

  describe("#given a task id containing regex metacharacters", () => {
    test("#when it appears in a summary line #then the exact-escaped summary matcher still resolves it", async () => {
      const chunk = "- `bg_evil.+id`: weird task | session: `ses_meta_chars`"
      const client = clientWithMessages([textMessage("m1", chunk)])

      const sessionId = await findSessionIdInParentTranscript(client, PARENT_SESSION_ID, "bg_evil.+id")

      expect(sessionId).toBe("ses_meta_chars")
    })

    test("#when it appears in launch text near an unrelated session #then it neither throws nor falsely pairs", async () => {
      const chunk = [launchRecord("bg_normal", "ses_normal"), "", "Task ID: bg_evil.+id"].join("\n")
      const client = clientWithMessages([textMessage("m1", chunk)])

      const sessionId = await findSessionIdInParentTranscript(client, PARENT_SESSION_ID, "bg_evil.+id")

      expect(sessionId).toBeUndefined()
    })
  })

  describe("#given a tool_result content array holding a non-string truthy text block", () => {
    test("#when the transcript is scanned #then it does not throw and still finds the pairing in a later part", async () => {
      const client = clientWithMessages([
        {
          id: "m1",
          info: { role: "assistant", time: "2026-08-07T00:00:01.000Z" },
          parts: [
            { type: "tool_result", content: [{ type: "text", text: unsafeTestValue<string>(12345) }] },
            { type: "text", text: launchRecord("bg_guarded", "ses_guarded") },
          ],
        },
      ])

      const sessionId = await findSessionIdInParentTranscript(client, PARENT_SESSION_ID, "bg_guarded")

      expect(sessionId).toBe("ses_guarded")
    })
  })
})
