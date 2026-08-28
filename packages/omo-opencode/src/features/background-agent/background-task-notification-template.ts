import { buildBlockedAnswerInstruction } from "./blocked-answer-instruction"
import { sanitizeUntrustedText } from "./untrusted-text"
import type { BackgroundTaskAttempt, BackgroundTaskCompletionReason, BackgroundTaskStatus } from "./types"

export type BackgroundTaskNotificationStatus = "COMPLETED" | "BLOCKED" | "CANCELLED" | "INTERRUPTED" | "ERROR"

export interface BackgroundTaskNotificationTask {
  id: string
  description: string
  status: BackgroundTaskStatus
  error?: string
  attempts?: BackgroundTaskAttempt[]
  sessionId?: string
  blockedAt?: Date
  blockedReason?: string
  unfinishedTodoCount?: number
  completionReason?: BackgroundTaskCompletionReason
}

function formatAttemptModel(attempt: BackgroundTaskAttempt): string {
  if (attempt.providerId && attempt.modelId) {
    return `${attempt.providerId}/${attempt.modelId}`
  }

  if (attempt.modelId) {
    return attempt.modelId
  }

  if (attempt.providerId) {
    return attempt.providerId
  }

  return "unknown-model"
}

function formatAttemptTimeline(task: BackgroundTaskNotificationTask): string {
  if (!task.attempts || task.attempts.length <= 1) {
    return ""
  }

  const lines = task.attempts
    .map((attempt) => {
      const attemptLines = [
        `  - Attempt ${attempt.attemptNumber} - ${attempt.status.toUpperCase()} - ${formatAttemptModel(attempt)} - ${attempt.sessionId ?? "unknown"}`,
      ]

      if (attempt.status !== "completed" && attempt.error) {
        attemptLines.push(`    Error: ${sanitizeUntrustedText(attempt.error, 1000)}`)
      }

      return attemptLines.join("\n")
    })
    .join("\n")

  return `Background task attempts:\n${lines}`
}

function formatTaskSummaryLine(task: BackgroundTaskNotificationTask): string {
  const sessionSuffix = task.sessionId ? ` | session: \`${task.sessionId}\`` : ""
  const safeDescription = sanitizeUntrustedText(task.description || task.id, 200).replace(/\n+/g, " ")
  const baseLine = `- \`${task.id}\`: ${safeDescription}${sessionSuffix}`
  const statusSuffix = task.status === "completed"
    ? `${task.unfinishedTodoCount && task.unfinishedTodoCount > 0
      ? ` - completed with ${task.unfinishedTodoCount} unfinished todo${task.unfinishedTodoCount === 1 ? "" : "s"}`
      : ""}${task.completionReason ? `, reason: ${task.completionReason}` : ""}`
    : ` [${task.status.toUpperCase()}]${task.error ? ` - ${sanitizeUntrustedText(task.error, 2000)}` : ""}`
  const timeline = formatAttemptTimeline(task)

  return `${baseLine}${statusSuffix}${timeline ? `\n${timeline}` : ""}`
}

/**
 * A task that parks and resumes is notified once per cycle, and every cycle appends another
 * row for the same task id. Rendering that list raw reports one "failure" per park - the
 * summary once claimed 14 failures for 2 real tasks. Collapse to the LAST entry per id, which
 * is the task's final observed state.
 */
function dedupeByTaskId(tasks: BackgroundTaskNotificationTask[]): BackgroundTaskNotificationTask[] {
  const lastById = new Map<string, BackgroundTaskNotificationTask>()
  for (const task of tasks) {
    lastById.set(task.id, task)
  }
  return [...lastById.values()]
}

export function buildBackgroundTaskNotificationText(input: {
  task: BackgroundTaskNotificationTask
  duration: string
  statusText: BackgroundTaskNotificationStatus
  allComplete: boolean
  remainingCount: number
  completedTasks: BackgroundTaskNotificationTask[]
}): string {
  const { task, duration, statusText, allComplete, remainingCount, completedTasks: rawCompletedTasks } = input
  const completedTasks = dedupeByTaskId(rawCompletedTasks)

  const safeDescription = (t: BackgroundTaskNotificationTask): string =>
    sanitizeUntrustedText(t.description || t.id, 200)
  const errorInfo = task.error ? `\n**Error:** ${sanitizeUntrustedText(task.error)}` : ""
  const isBlocked = statusText === "BLOCKED"

  if (allComplete && !isBlocked) {
    const succeededTasks = completedTasks.filter((t) => t.status === "completed")
    const failedTasks = completedTasks.filter((t) => t.status !== "completed")

    const succeededText = succeededTasks.length > 0
      ? succeededTasks.map((t) => formatTaskSummaryLine(t)).join("\n")
      : ""
    const failedText = failedTasks.length > 0
      ? failedTasks.map((t) => formatTaskSummaryLine(t)).join("\n")
      : ""

    const hasFailures = failedTasks.length > 0
    const header = hasFailures
      ? `[ALL BACKGROUND TASKS FINISHED - ${failedTasks.length} FAILED]`
      : "[BACKGROUND TASK COMPLETED]\n[ALL BACKGROUND TASKS COMPLETE]"

    let body = ""
    if (succeededText) {
      body += `**Completed:**\n${succeededText}\n`
    }
    if (failedText) {
      body += `\n**Failed:**\n${failedText}\n`
    }
    if (!body) {
      body = `${formatTaskSummaryLine(task)}\n`
    }

    const hasSessionHandles = completedTasks.some((t) => t.sessionId) || Boolean(task.sessionId)
    const resultCollectionInstruction = hasSessionHandles
      ? "All sibling background tasks are complete. Your next action should be to call `background_output(task_id=\"<id>\")` for each task ID above. If a task ID returns not-found, fall back to `session_read(session_id=\"<session>\")` using the session id on that task's line."
      : "All sibling background tasks are complete. Your next action should be to call `background_output(task_id=\"<id>\")` for each task ID above."

    return `<system-reminder>
${header}

${body.trim()}

${resultCollectionInstruction}${hasFailures ? `\n\n**ACTION REQUIRED:** ${failedTasks.length} task(s) failed. Check errors above and decide whether to retry or proceed.` : ""}
</system-reminder>`
  }

  const isGenuineFailure = statusText !== "COMPLETED" && statusText !== "BLOCKED"
  const header = isBlocked
    ? "[BACKGROUND TASK BLOCKED]"
    : isGenuineFailure
      ? `[BACKGROUND TASK ${statusText}]`
      : "[BACKGROUND TASK RESULT READY]"
  const completedSiblingText = isBlocked && allComplete
    ? completedTasks
      .filter((completedTask) => completedTask.id !== task.id && completedTask.status === "completed")
      .map(formatTaskSummaryLine)
      .join("\n")
    : ""
  const blockedInstruction = isBlocked
    ? `\n\n**Blocked:** ${sanitizeUntrustedText(task.blockedReason ?? task.error ?? "No reason provided")}\n${buildBlockedAnswerInstruction(task.sessionId ?? "unknown-session")}${completedSiblingText ? `\n\n**Completed siblings:**\n${completedSiblingText}` : ""}`
    : ""

  // The `| session: \`ses_...\`` suffix is the machine-parsable handle the
  // cross-runtime transcript scanner recognizes (parent-transcript-pairing.ts
  // summary-line shape). Without it, the mid-batch notification promises a
  // session_read fallback its own format defeats.
  const sessionHandle = task.sessionId ? ` | session: \`${task.sessionId}\`` : ""

  return `<system-reminder>
${header}
**ID:** \`${task.id}\`${sessionHandle}
**Description:** ${safeDescription(task)}
**Duration:** ${duration}${errorInfo}${blockedInstruction}

${allComplete && isBlocked ? "**All other background tasks are complete.**" : `**${remainingCount} task${remainingCount === 1 ? "" : "s"} still in progress.** You WILL be notified when ALL complete.`}
${isBlocked ? "**CHILD AWAITING RESPONSE:** Answer the child to unblock it." : isGenuineFailure ? "**ACTION REQUIRED:** This task failed. Check the error and decide whether to retry, cancel remaining tasks, or continue." : "Do NOT poll - continue productive work."}

Use \`background_output(task_id="${task.id}")\` to retrieve this result when ready.${task.sessionId ? ` If that returns not-found, fall back to \`session_read(session_id="${task.sessionId}")\`.` : ""}
</system-reminder>`
}
