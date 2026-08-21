import { RUNTIME_ID } from "@oh-my-opencode/utils"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { BackgroundTask } from "../../features/background-agent"
import { isTaskBlocked } from "../../features/background-agent/blocked-state"
import { publishToolMetadata } from "../../features/tool-metadata-store"
import { log } from "../../shared/logger"
import type { BackgroundOutputArgs } from "./types"
import type { BackgroundOutputClient, BackgroundOutputManager } from "./clients"
import { BACKGROUND_OUTPUT_DESCRIPTION } from "./constants"
import { delay } from "./delay"
import { formatFullSession } from "./full-session-format"
import { findSessionIdInParentTranscript } from "./parent-transcript-pairing"
import { formatTaskResult } from "./task-result-format"
import { formatTaskStatus } from "./task-status-format"

import { getAgentDisplayName } from "../../shared/agent-display-names"
import { recordBackgroundOutputConsumption } from "../../shared/background-output-consumption"

const SISYPHUS_JUNIOR_AGENT = getAgentDisplayName("sisyphus-junior")
const MISSING_BACKGROUND_TASK_RETRY_DELAY_MS = 100
const BACKGROUND_OUTPUT_POLL_INTERVAL_MS = 100

type ToolContextWithMetadata = {
  sessionID: string
  messageID?: string
  metadata?: (input: { title?: string; metadata?: Record<string, unknown> }) => void
  callID?: string
  callId?: string
  call_id?: string
}

function formatResolvedTitle(task: BackgroundTask): string {
  const label = task.agent === SISYPHUS_JUNIOR_AGENT && task.category ? task.category : task.agent
  return `${label} - ${task.description}`
}

function isTaskActiveStatus(status: BackgroundTask["status"]): boolean {
  return status === "pending" || status === "running"
}

function appendTimeoutNote(output: string, timeoutMs: number): string {
  return `${output}\n\n> **Timed out waiting** after ${timeoutMs}ms. Task is still running; showing latest available output.`
}

function isSessionId(value: string): boolean {
  return /^ses[_-]/.test(value)
}

function isBackgroundTaskId(value: string): boolean {
  return /^bg[_-]/.test(value)
}

async function getTaskWithMissingRetry(
  manager: BackgroundOutputManager,
  taskId: string,
): Promise<BackgroundTask | undefined> {
  const task = manager.getTask(taskId)
  if (task || !isBackgroundTaskId(taskId)) {
    return task
  }

  log("[background_output] background task missing on first lookup; retrying", {
    taskId,
    retryDelayMs: MISSING_BACKGROUND_TASK_RETRY_DELAY_MS,
  })

  await delay(MISSING_BACKGROUND_TASK_RETRY_DELAY_MS)
  const retriedTask = manager.getTask(taskId)

  log(
    retriedTask
      ? "[background_output] recovered background task after missing lookup retry"
      : "[background_output] background task still missing after retry",
    {
      taskId,
      status: retriedTask?.status,
      sessionId: retriedTask?.sessionId,
    }
  )

  return retriedTask
}

// `taskHistory` is NOT a valid fallback source here. It is per-process
// in-memory state (`TaskHistory`, `task-history.ts`), so it is empty in exactly
// the runtime that fails this lookup. The miss is a process/realm split, not a
// retention race; see `.omo/plans/bg-wake-and-crossprocess-lookup.md`.
// Instead, scan the calling session's transcript (server/DB-backed, therefore
// process-independent) for the `bg_... → ses_...` pairing that the launch
// output and the completion notification both record.
async function recoverFromParentTranscript(
  client: BackgroundOutputClient,
  ctx: ToolContextWithMetadata,
  args: BackgroundOutputArgs,
): Promise<string | undefined> {
  if (!isBackgroundTaskId(args.task_id) || !ctx.sessionID) {
    return undefined
  }

  const recoveredSessionId = await findSessionIdInParentTranscript(client, ctx.sessionID, args.task_id)
  if (!recoveredSessionId) {
    return undefined
  }

  log("[background_output] recovered child session id from the parent transcript", {
    taskId: args.task_id,
    sessionId: recoveredSessionId,
    parentSessionId: ctx.sessionID,
  })

  const recoveredTask: BackgroundTask = {
    id: args.task_id,
    sessionId: recoveredSessionId,
    parentSessionId: ctx.sessionID,
    parentMessageId: ctx.messageID ?? "",
    description: `Recovered from the parent transcript (task owned by another runtime)`,
    prompt: "",
    agent: "unknown",
    // The task belongs to another runtime, so this one cannot observe whether it finished,
    // failed, or was killed mid-flight. Keep the record non-terminal and render the status
    // as unknown rather than asserting a success we have no evidence for.
    status: "running",
  }

  await publishToolMetadata(ctx, {
    title: formatResolvedTitle(recoveredTask),
    metadata: {
      backgroundTaskId: recoveredTask.id,
      agent: recoveredTask.agent,
      description: recoveredTask.description,
      sessionId: recoveredSessionId,
      taskId: recoveredSessionId,
    },
  })

  const output = await formatFullSession(recoveredTask, client, {
    includeThinking: args.include_thinking ?? false,
    messageLimit: args.message_limit,
    sinceMessageId: args.since_message_id,
    includeToolResults: args.include_tool_results ?? false,
    thinkingMaxChars: args.thinking_max_chars,
    fromEnd: args.from_end ?? true,
    statusLabel: "unknown (recovered from transcript; this runtime cannot observe the task's outcome)",
  })

  recordBackgroundOutputConsumption(ctx.sessionID, ctx.messageID, recoveredSessionId)

  return `> **Note:** This background task is owned by a different runtime than the one serving this tool call, so its in-memory record is unreachable here. The result below was recovered from the child session transcript (\`${recoveredSessionId}\`). The transcript shows what the child produced, but it does NOT prove the task ran to completion - it may have been killed mid-flight - so treat the outcome as unverified and check the final message before relying on it.

${output}`
}

function resolveRuntimeIdLabel(): string {
  // RUNTIME_ID identifies the process + module realm. Guarded so the message
  // still renders if the shared logger export is ever unavailable at runtime.
  try {
    return typeof RUNTIME_ID === "string" && RUNTIME_ID.length > 0 ? ` (this runtime is \`rt:${RUNTIME_ID}\`)` : ""
  } catch {
    return ""
  }
}

function formatTaskNotFoundMessage(taskId: string): string {
  if (isSessionId(taskId)) {
    return `Task not found: ${taskId}

background_output expects a background task ID such as \`bg_...\`, not a session ID.
Use the \`background_task_id\` / \`Background Task ID\` from the task launch output or completion notification.
To inspect this session directly, use \`session_read(session_id="${taskId}")\`, \`session_info\`, or \`session_search\`.`
  }

  if (isBackgroundTaskId(taskId)) {
    return `Task not found in this runtime: ${taskId}

Two possibilities:
1. The task id never existed - check the launch output for the exact \`bg_...\` id.
2. The task is owned by a different runtime (process/realm) than the one serving this tool call${resolveRuntimeIdLabel()}. Background task state is per-runtime memory; when terminal opencode, \`opencode serve\`, and IDE-embedded opencode run side by side, a task launched in one is invisible to the others. This is NOT a retention/cleanup race; the owning runtime may still hold the task.

Recovery: use \`session_read(session_id="ses_...")\` with the session id from the task's launch output or completion notification (the \`| session: \`ses_...\`\` suffix). Session transcripts are server-backed and readable from every runtime.`
  }

  return `Task not found: ${taskId}

background_output expects a background task ID such as \`bg_...\` from the task launch output or completion notification.`
}

export function createBackgroundOutput(manager: BackgroundOutputManager, client: BackgroundOutputClient): ToolDefinition {
  return tool({
    description: BACKGROUND_OUTPUT_DESCRIPTION,
    args: {
      task_id: tool.schema
        .string()
        .describe("background task ID (`bg_...`) from launch/completion; not a session ID (`ses_...`)."),
      block: tool.schema
        .boolean()
        .optional()
        .describe(
          "Wait for completion (default: false). System notifies when done, so blocking is rarely needed."
        ),
      timeout: tool.schema.number().optional().describe("Max wait time in ms (default: 60000, max: 600000)"),
      full_session: tool.schema.boolean().optional().describe("Return full session messages with filters (default: false)"),
      include_thinking: tool.schema.boolean().optional().describe("Include thinking/reasoning parts in full_session output (default: false)"),
      message_limit: tool.schema.number().optional().describe("Max messages to return (capped at 200)"),
      since_message_id: tool.schema.string().optional().describe("Return messages after this message ID (exclusive)"),
      include_tool_results: tool.schema.boolean().optional().describe("Include tool results in full_session output (default: false)"),
      thinking_max_chars: tool.schema.number().optional().describe("Max characters for thinking content (default: 2000)"),
      from_end: tool.schema.boolean().optional().describe("Read messages from the END of the session (default: false). Pass true to get the most-recent / final assistant message in the output. Recommended when you want the result of a completed task."),
    },
    async execute(args: BackgroundOutputArgs, toolContext) {
      try {
        const ctx = toolContext as ToolContextWithMetadata
        const task = await getTaskWithMissingRetry(manager, args.task_id)
        if (!task) {
          const recovered = await recoverFromParentTranscript(client, ctx, args)
          if (recovered !== undefined) {
            return recovered
          }
          return formatTaskNotFoundMessage(args.task_id)
        }

        const meta = {
          title: formatResolvedTitle(task),
          metadata: {
            backgroundTaskId: task.id,
            agent: task.agent,
            category: task.category,
            description: task.description,
            ...(task.sessionId ? { sessionId: task.sessionId, taskId: task.sessionId } : {}),
          } as Record<string, unknown>,
        }
        await publishToolMetadata(ctx, meta)

        const shouldBlock = args.block === true
        const timeoutMs = Math.min(args.timeout ?? 60000, 600000)

        let resolvedTask = task

        let didTimeoutWhileActive = false

        if (shouldBlock && isTaskActiveStatus(task.status)) {
          const startTime = Date.now()
          while (Date.now() - startTime < timeoutMs) {
            const remainingMs = timeoutMs - (Date.now() - startTime)
            await delay(Math.min(BACKGROUND_OUTPUT_POLL_INTERVAL_MS, Math.max(1, remainingMs)))

            const currentTask = await getTaskWithMissingRetry(manager, args.task_id)
            if (!currentTask) {
              return `Task was deleted: ${args.task_id}`
            }

            resolvedTask = currentTask

            if (!isTaskActiveStatus(currentTask.status)) {
              break
            }
          }

          if (isTaskActiveStatus(resolvedTask.status)) {
            const finalCheck = await getTaskWithMissingRetry(manager, args.task_id)
            if (finalCheck) {
              resolvedTask = finalCheck
            }
          }

          if (isTaskActiveStatus(resolvedTask.status)) {
            didTimeoutWhileActive = true
          }
        }

        const isActive = isTaskActiveStatus(resolvedTask.status)
        const fullSession = args.full_session ?? false
        const includeThinking = isActive || (args.include_thinking ?? false)
        const includeToolResults = isActive || (args.include_tool_results ?? false)

        if (fullSession) {
          const output = await formatFullSession(resolvedTask, client, {
            includeThinking,
            messageLimit: args.message_limit,
            sinceMessageId: args.since_message_id,
            includeToolResults,
            thinkingMaxChars: args.thinking_max_chars,
            fromEnd: args.from_end,
          })

          return didTimeoutWhileActive ? appendTimeoutNote(output, timeoutMs) : output
        }

        if (isTaskBlocked(resolvedTask)) {
          return formatTaskStatus(resolvedTask)
        }

        if (resolvedTask.status === "completed") {
          recordBackgroundOutputConsumption(ctx.sessionID, ctx.messageID, resolvedTask.sessionId)
          return await formatTaskResult(resolvedTask, client)
        }

        if (resolvedTask.status === "error" || resolvedTask.status === "cancelled" || resolvedTask.status === "interrupt") {
          return formatTaskStatus(resolvedTask)
        }

        const statusOutput = formatTaskStatus(resolvedTask)
        return didTimeoutWhileActive ? appendTimeoutNote(statusOutput, timeoutMs) : statusOutput
      } catch (error) {
        return `Error getting output: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
