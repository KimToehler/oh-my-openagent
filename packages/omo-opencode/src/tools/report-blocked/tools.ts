import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { BackgroundManager } from "../../features/background-agent"

export type ReportBlockedManager = Pick<BackgroundManager, "findBySession" | "notifyBlockedTask" | "cancelTask" | "failBlockedTask">

const MAX_BLOCKED_PARKS = 3

function formatBlockedReason(reason: string, needs: string): string {
  return `Reason: ${reason}\nNeeds from parent: ${needs}`
}

export function createReportBlockedTool(manager: ReportBlockedManager): ToolDefinition {
  return tool({
    description: `Report that this background subagent is blocked waiting for parent input.

Use this only when the agent needs a decision, credential, missing API, or clarification that only the parent can supply. Do NOT use this for a long-running or detached job that is still executing - a job that is still running is not a blocker, poll it instead.

This notifies the parent, then parks the current background task until the parent resumes it. Only background subagents can use this tool.`,
    args: {
      reason: tool.schema.string().min(1).describe("What is preventing progress"),
      needs: tool.schema.string().min(1).describe("What input or action is needed from the parent"),
    },
    async execute(args, context) {
      const task = manager.findBySession(context.sessionID)
      if (task === undefined) {
        return "[ERROR] This is not a background subagent session. report_blocked can only park background subagents."
      }

      const blockedReason = formatBlockedReason(args.reason, args.needs)
      const priorParks = task.blockedParkCount ?? 0
      if (priorParks >= MAX_BLOCKED_PARKS) {
        const recurringBlockError = `Recurring blocked state after ${priorParks} prior park attempts: ${blockedReason}`
        await manager.failBlockedTask(task.id, recurringBlockError)
        return `[ERROR] Background task failed after ${priorParks} prior park attempts because the blocked state recurred.`
      }
      task.blockedParkCount = priorParks + 1
      task.blockedAt = new Date()
      task.blockedReason = blockedReason

      await manager.notifyBlockedTask(task.id)
      const parked = await manager.cancelTask(task.id, {
        source: "report_blocked",
        reason: blockedReason,
        abortSession: true,
        skipNotification: true,
      })

      if (!parked) {
        return `[ERROR] The parent was notified, but report_blocked failed to park this child. Current task status: ${task.status}. This background subagent must not wait silently.`
      }

      return "Blocked state reported to parent and background subagent parked."
    },
  })
}
