import type { BackgroundTask } from "../../features/background-agent"
import { DEFAULT_STALE_TIMEOUT_MS } from "../../features/background-agent/constants"
import { MIN_SESSION_GONE_POLLS } from "../../features/background-agent/session-existence"
import { buildBlockedAnswerInstruction } from "../../features/background-agent/blocked-answer-instruction"
import { isTaskBlocked } from "../../features/background-agent/blocked-state"
import { formatDuration } from "./time-format"
import { truncateText } from "./truncate-text"

export function formatTaskStatus(task: BackgroundTask): string {
  let duration: string
  if (task.status === "pending" && task.queuedAt) {
    duration = formatDuration(task.queuedAt, undefined)
  } else if (task.startedAt) {
    duration = formatDuration(task.startedAt, task.completedAt)
  } else {
    duration = "N/A"
  }

  const promptPreview = truncateText(task.prompt, 500)

  let progressSection = ""
  if (task.progress?.lastTool) {
    progressSection = `\n| Last tool | ${task.progress.lastTool} |`
  }

  let lastMessageSection = ""
  if (task.progress?.lastMessage) {
    const truncated = truncateText(task.progress.lastMessage, 500)
    const messageTime = task.progress.lastMessageAt ? task.progress.lastMessageAt.toISOString() : "N/A"
    lastMessageSection = `

## Last Message (${messageTime})

\`\`\`
${truncated}
\`\`\``
  }

  const blocked = isTaskBlocked(task)
  let statusNote = ""
  if (blocked) {
    statusNote = `

> **BLOCKED**: ${task.blockedReason ?? "Reason not provided."}
>
> ${buildBlockedAnswerInstruction(task.sessionId ?? task.id)}`
  } else if (task.status === "pending") {
     statusNote = `

> **Queued**: Task is waiting for a concurrency slot to become available.`
   } else if (task.status === "running") {
     const silence = describeRunningSilence(task)
     statusNote = silence ?? `

> **Note**: No need to wait explicitly - the system will notify you when this task completes.`
   } else if (task.status === "error") {
     statusNote = `

> **Failed**: The task encountered an error. Check the last message for details.`
   } else if (task.status === "interrupt") {
     statusNote = `

> **Interrupted**: The task was interrupted by a prompt error. The session may contain partial results.`
   }

  const durationLabel = task.status === "pending" ? "Queued for" : "Duration"

  return `# Task Status

| Field | Value |
|-------|-------|
| Task ID | \`${task.id}\` |
| Description | ${task.description} |
| Agent | ${task.agent} |
| Status | **${blocked ? "BLOCKED" : task.status}** |
| ${durationLabel} | ${duration} |
| Session ID | \`${task.sessionId}\` |${progressSection}
${statusNote}
## Original Prompt

\`\`\`
${promptPreview}
\`\`\`${lastMessageSection}`
}

/**
 * A `running` status is the manager's belief, not an observation. When the child
 * has gone quiet past the point where the poller would act, or has dropped out of
 * the session registry, saying "the system will notify you" is a promise the
 * harness may not keep. Report the silence instead so the reader can check the
 * work on disk rather than waiting on a status line that cannot move.
 */
function describeRunningSilence(task: BackgroundTask): string | undefined {
  const missedPolls = task.consecutiveMissedPolls ?? 0
  if (missedPolls >= MIN_SESSION_GONE_POLLS && task.sessionId) {
    return `

> **Note**: This session was not present in the session registry for the last ${missedPolls} polls, so the child may already have exited. Verify progress on disk rather than waiting on this status.`
  }

  const lastActivityAt = task.progress?.lastUpdate ?? task.startedAt
  if (!lastActivityAt) return undefined

  const silentMs = Date.now() - lastActivityAt.getTime()
  if (silentMs < DEFAULT_STALE_TIMEOUT_MS) return undefined

  return `

> **Note**: No session activity for ${Math.floor(silentMs / 60_000)}m. The task is still marked running, but nothing has been observed from the child; verify progress on disk rather than waiting on this status.`
}
