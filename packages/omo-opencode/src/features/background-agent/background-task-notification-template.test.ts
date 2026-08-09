// allow: SIZE_OK - notification template tests cover one rendering contract with shared cases; this release adds narrow status cases and future additions should split by template section.

import { describe, expect, test } from "bun:test"
import type { BackgroundOutputClient } from "../../tools/background-task/clients"
import { findSessionIdInParentTranscript } from "../../tools/background-task/parent-transcript-pairing"
import { buildBackgroundTaskNotificationText } from "./background-task-notification-template"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"

function clientWithNotificationText(text: string): BackgroundOutputClient {
  return {
    session: {
      messages: async () => ({
        data: [
          {
            id: "m-notification",
            info: { role: "assistant", time: "2026-08-07T00:00:10.000Z" },
            parts: [{ type: "text", text }],
          },
        ],
      }),
    },
  }
}

describe("buildBackgroundTaskNotificationText", () => {
  describe("#given one task still running after a completed task notification", () => {
    test("#when building the partial notification #then it does not use the final completed heading", () => {
      // given
      const notification = buildBackgroundTaskNotificationText({
        task: {
          id: "task-1",
          description: "Index repo",
          status: "completed",
        },
        duration: "42s",
        statusText: "COMPLETED",
        allComplete: false,
        remainingCount: 1,
        completedTasks: [],
      })

      // then
      expect(notification).not.toContain("[BACKGROUND TASK COMPLETED]")
      expect(notification).toContain("[BACKGROUND TASK RESULT READY]")
      expect(notification).toContain("You WILL be notified when ALL complete.")
    })

    test("#when building the partial notification #then it preserves the existing completed-task format", () => {
      // given
      const notification = buildBackgroundTaskNotificationText({
        task: {
          id: "task-1",
          description: "Index repo",
          status: "completed",
        },
        duration: "42s",
        statusText: "COMPLETED",
        allComplete: false,
        remainingCount: 1,
        completedTasks: [],
      })

      // when
      const expectedNotification = `<system-reminder>
[BACKGROUND TASK RESULT READY]
**ID:** \`task-1\`
**Description:** Index repo
**Duration:** 42s

**1 task still in progress.** You WILL be notified when ALL complete.
Do NOT poll - continue productive work.

Use \`background_output(task_id="task-1")\` to retrieve this result when ready.
</system-reminder>`

      // then
      expect(notification).toBe(expectedNotification)
    })
  })


  describe("#given a blocked cancelled task", () => {
    test("#when building the partial notification #then it renders an actionable blocked wake", () => {
      // given
      const notification = buildBackgroundTaskNotificationText({
        task: {
          id: "bg_blocked_1",
          description: "Inspect remote logs",
          status: "cancelled",
          error: "Reason: repeated gateway timeout\nNeeds: refreshed API credentials",
          blockedAt: new Date("2026-08-09T10:00:00.000Z"),
          blockedReason: "Reason: repeated gateway timeout\nNeeds: refreshed API credentials",
          sessionId: "ses_blocked_child_123",
        },
        duration: "2m 5s",
        statusText: "BLOCKED",
        allComplete: false,
        remainingCount: 1,
        completedTasks: [],
      })

      // then
      expect(notification).toContain("[BACKGROUND TASK BLOCKED]")
      expect(notification).toContain("repeated gateway timeout")
      expect(notification).toContain("refreshed API credentials")
      expect(notification).toContain('task(task_id="ses_blocked_child_123", prompt="<your answer>")')
    })
  })

  describe("#given a cancelled task without blocked metadata", () => {
    test("#when building the partial notification #then it keeps the cancelled header", () => {
      // given
      const notification = buildBackgroundTaskNotificationText({
        task: {
          id: "bg_cancelled_1",
          description: "Cancelled task",
          status: "cancelled",
          error: "User cancelled",
          sessionId: "ses_cancelled_child_123",
        },
        duration: "10s",
        statusText: "CANCELLED",
        allComplete: false,
        remainingCount: 1,
        completedTasks: [],
      })

      // then
      expect(notification).toContain("[BACKGROUND TASK CANCELLED]")
      expect(notification).not.toContain("[BACKGROUND TASK BLOCKED]")
    })
  })
  describe("#given one task still running after a failed task notification", () => {
    test("#when building the partial notification #then it preserves the existing failure format", () => {
      // given
      const notification = buildBackgroundTaskNotificationText({
        task: {
          id: "task-2",
          description: "Summarize logs",
          status: "error",
          error: "Timed out",
        },
        duration: "3m 4s",
        statusText: "ERROR",
        allComplete: false,
        remainingCount: 2,
        completedTasks: [],
      })

      // when
      const expectedNotification = `<system-reminder>
[BACKGROUND TASK ERROR]
**ID:** \`task-2\`
**Description:** Summarize logs
**Duration:** 3m 4s
**Error:** Timed out

**2 tasks still in progress.** You WILL be notified when ALL complete.
**ACTION REQUIRED:** This task failed. Check the error and decide whether to retry, cancel remaining tasks, or continue.

Use \`background_output(task_id="task-2")\` to retrieve this result when ready.
</system-reminder>`

      // then
      expect(notification).toBe(expectedNotification)
    })
  })

  describe("#given all sibling tasks completed with mixed outcomes", () => {
    test("#when building the final notification #then it preserves the existing summary format", () => {
      // given
      const notification = buildBackgroundTaskNotificationText({
        task: {
          id: "task-3",
          description: "Fallback task",
          status: "error",
          error: "Denied",
        },
        duration: "10s",
        statusText: "ERROR",
        allComplete: true,
        remainingCount: 0,
        completedTasks: [
          {
            id: "task-1",
            description: "Index repo",
            status: "completed",
          },
          {
            id: "task-2",
            description: "Summarize logs",
            status: "cancelled",
            error: "User aborted",
          },
          {
            id: "task-3",
            description: "Fallback task",
            status: "error",
            error: "Denied",
          },
        ],
      })

      // when
      const expectedNotification = `<system-reminder>
[ALL BACKGROUND TASKS FINISHED - 2 FAILED]

**Completed:**
- \`task-1\`: Index repo

**Failed:**
- \`task-2\`: Summarize logs [CANCELLED] - User aborted
- \`task-3\`: Fallback task [ERROR] - Denied

All sibling background tasks are complete. Your next action should be to call \`background_output(task_id="<id>")\` for each task ID above.

**ACTION REQUIRED:** 2 task(s) failed. Check errors above and decide whether to retry or proceed.
</system-reminder>`

      // then
      expect(notification).toBe(expectedNotification)
    })
  })

  describe("#given all tasks completed with undefined descriptions", () => {
    test("#when building the final notification #then it uses task ID as fallback instead of 'undefined'", () => {
      // given
      const notification = buildBackgroundTaskNotificationText({
        task: {
          id: "bg_abc123",
          description: unsafeTestValue<string>(undefined),
          status: "completed",
        },
        duration: "5s",
        statusText: "COMPLETED",
        allComplete: true,
        remainingCount: 0,
        completedTasks: [
          { id: "bg_abc123", description: unsafeTestValue<string>(undefined), status: "completed" },
          { id: "bg_def456", description: unsafeTestValue<string>(undefined), status: "completed" },
        ],
      })

      // then
      expect(notification).not.toContain(": undefined")
      expect(notification).toContain("bg_abc123")
      expect(notification).toContain("bg_def456")
    })
  })

  describe("#given a completed task with retry attempt history", () => {
    test("#when building the final notification #then it includes the final completed heading", () => {
      // given
      const notification = buildBackgroundTaskNotificationText({
        task: {
          id: "task-3",
          description: "Fallback task",
          status: "completed",
        },
        duration: "10s",
        statusText: "COMPLETED",
        allComplete: true,
        remainingCount: 0,
        completedTasks: [
          {
            id: "task-3",
            description: "Fallback task",
            status: "completed",
          },
        ],
      })

      // then
      expect(notification).toContain("[BACKGROUND TASK COMPLETED]")
      expect(notification).toContain("[ALL BACKGROUND TASKS COMPLETE]")
    })

    test("#when building the final notification #then it tells the agent to collect outputs immediately", () => {
      // given
      const notification = buildBackgroundTaskNotificationText({
        task: {
          id: "bg_task_1",
          description: "Trace repo",
          status: "completed",
        },
        duration: "10s",
        statusText: "COMPLETED",
        allComplete: true,
        remainingCount: 0,
        completedTasks: [
          {
            id: "bg_task_1",
            description: "Trace repo",
            status: "completed",
          },
        ],
      })

      // then
      expect(notification).toContain("All sibling background tasks are complete.")
      expect(notification).toContain("Your next action should be to call `background_output(task_id=\"<id>\")` for each task ID above.")
      expect(notification).not.toContain("Wait for the all-complete notification")
    })

    test("#when building the final notification #then it renders the spec-aligned balanced attempt timeline", () => {
      // given
      const notification = buildBackgroundTaskNotificationText({
        task: {
          id: "task-3",
          description: "Fallback task",
          status: "completed",
          attempts: [
            {
              attemptId: "att-1",
              attemptNumber: 1,
              sessionId: "ses-primary",
              providerId: "genai-proxy-openai",
              modelId: "gpt-5.6-luna-fast",
              status: "error",
              error: "Forbidden: Selected provider is forbidden",
            },
            {
              attemptId: "att-2",
              attemptNumber: 2,
              sessionId: "ses-fallback",
              providerId: "anthropic",
              modelId: "claude-haiku-4.5",
              status: "completed",
            },
          ],
        },
        duration: "10s",
        statusText: "COMPLETED",
        allComplete: true,
        remainingCount: 0,
        completedTasks: [
          {
            id: "task-3",
            description: "Fallback task",
            status: "completed",
            attempts: [
              {
                attemptId: "att-1",
                attemptNumber: 1,
                sessionId: "ses-primary",
                providerId: "genai-proxy-openai",
                modelId: "gpt-5.6-luna-fast",
                status: "error",
                error: "Forbidden: Selected provider is forbidden",
              },
              {
                attemptId: "att-2",
                attemptNumber: 2,
                sessionId: "ses-fallback",
                providerId: "anthropic",
                modelId: "claude-haiku-4.5",
                status: "completed",
              },
            ],
          },
        ],
      })

      // then
      expect(notification).toContain("[ALL BACKGROUND TASKS COMPLETE]")
      expect(notification).toContain("- `task-3`: Fallback task")
      expect(notification).toContain("Background task attempts:")
      expect(notification).toContain("  - Attempt 1 — ERROR — genai-proxy-openai/gpt-5.6-luna-fast — ses-primary")
      expect(notification).toContain("    Error: Forbidden: Selected provider is forbidden")
      expect(notification).toContain("  - Attempt 2 — COMPLETED — anthropic/claude-haiku-4.5 — ses-fallback")
    })
  })

  describe("#given a completed task with a child session id", () => {
    test("#when the completion notification is built #then the summary line carries the session id as a fallback handle", () => {
      // given
      const notification = buildBackgroundTaskNotificationText({
        task: {
          id: "bg_a4f323d2",
          description: "Cross-process repro task",
          status: "completed",
          sessionId: "ses_child_1",
        },
        duration: "9s",
        statusText: "COMPLETED",
        allComplete: true,
        remainingCount: 0,
        completedTasks: [
          {
            id: "bg_a4f323d2",
            description: "Cross-process repro task",
            status: "completed",
            sessionId: "ses_child_1",
          },
        ],
      })

      // then
      expect(notification).toContain("- `bg_a4f323d2`: Cross-process repro task | session: `ses_child_1`")
      expect(notification).toContain("session_read(session_id=")
    })

    test("#when a partial completion notification is built #then it offers the session id as a fallback handle", () => {
      // given
      const notification = buildBackgroundTaskNotificationText({
        task: {
          id: "bg_partial_1",
          description: "Mid-batch task",
          status: "completed",
          sessionId: "ses_child_2",
        },
        duration: "5s",
        statusText: "COMPLETED",
        allComplete: false,
        remainingCount: 1,
        completedTasks: [],
      })

      // then
      expect(notification).toContain("ses_child_2")
      expect(notification).toContain("session_read(session_id=\"ses_child_2\")")
    })
  })

  describe("#given a mid-batch notification recorded in the parent transcript", () => {
    test("#when the transcript scanner reads the success variant #then it recovers the child session id", async () => {
      // given
      const notification = buildBackgroundTaskNotificationText({
        task: {
          id: "bg_alpha",
          description: "Mid-batch success task",
          status: "completed",
          sessionId: "ses_mid",
        },
        duration: "5s",
        statusText: "COMPLETED",
        allComplete: false,
        remainingCount: 1,
        completedTasks: [],
      })

      // when
      const recovered = await findSessionIdInParentTranscript(
        clientWithNotificationText(notification),
        "ses_parent",
        "bg_alpha",
      )

      // then
      expect(recovered).toBe("ses_mid")
    })

    test("#when the transcript scanner reads the failure variant #then it recovers the child session id", async () => {
      // given
      const notification = buildBackgroundTaskNotificationText({
        task: {
          id: "bg_beta",
          description: "Mid-batch failed task",
          status: "error",
          error: "Timed out",
          sessionId: "ses_mf",
        },
        duration: "3m 4s",
        statusText: "ERROR",
        allComplete: false,
        remainingCount: 2,
        completedTasks: [],
      })

      // when
      const recovered = await findSessionIdInParentTranscript(
        clientWithNotificationText(notification),
        "ses_parent",
        "bg_beta",
      )

      // then
      expect(recovered).toBe("ses_mf")
    })

    test("#when a DIFFERENT task id is requested against the notification #then no session is recovered", async () => {
      // given
      const notification = buildBackgroundTaskNotificationText({
        task: {
          id: "bg_alpha",
          description: "Mid-batch success task",
          status: "completed",
          sessionId: "ses_mid",
        },
        duration: "5s",
        statusText: "COMPLETED",
        allComplete: false,
        remainingCount: 1,
        completedTasks: [],
      })

      // when
      const recovered = await findSessionIdInParentTranscript(
        clientWithNotificationText(notification),
        "ses_parent",
        "bg_other",
      )

      // then
      expect(recovered).toBeUndefined()
    })
  })

  describe("#given a single task notification with undefined description", () => {
    test("#when building the partial notification #then it uses task ID as fallback", () => {
      // given
      const notification = buildBackgroundTaskNotificationText({
        task: {
          id: "bg_xyz789",
          description: unsafeTestValue<string>(undefined),
          status: "completed",
        },
        duration: "3s",
        statusText: "COMPLETED",
        allComplete: false,
        remainingCount: 2,
        completedTasks: [],
      })

      // then
      expect(notification).not.toContain("undefined")
      expect(notification).toContain("bg_xyz789")
    })
  })
})
