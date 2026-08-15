import { contextCollector, type ContextCollector } from "../../features/context-injector/collector"
import { log } from "../../shared"
import { resolveSessionEventID } from "../../shared/event-session-id"

import { buildUnpolledShellJobMessage } from "./message"
import { forgetSession, getOutstandingJobs } from "./tracker"

type UnpolledShellJobEvent = {
  readonly event: {
    readonly type: string
    readonly properties?: unknown
  }
}

type Logger = (message: string, data?: Record<string, unknown>) => void

/** Job ids already warned about, per session, so repeated idles do not spam. */
const warnedJobs = new Map<string, Set<string>>()

/** @internal For testing only */
export function _resetWarnedForTesting(): void {
  warnedJobs.clear()
}

export function createUnpolledShellJobHook(
  collector: ContextCollector = contextCollector,
  logger: Logger = log,
): (input: UnpolledShellJobEvent) => Promise<void> {
  return async ({ event }) => {
    const sessionID = resolveSessionEventID(event.properties)
    if (sessionID === undefined) return

    if (event.type === "session.deleted") {
      forgetSession(sessionID)
      warnedJobs.delete(sessionID)
      return
    }
    if (event.type !== "session.idle") return

    const outstanding = getOutstandingJobs(sessionID)
    if (outstanding.length === 0) return

    const alreadyWarned = warnedJobs.get(sessionID) ?? new Set<string>()
    const unwarned = outstanding.filter((job) => !alreadyWarned.has(job.jobId))
    if (unwarned.length === 0) return

    collector.register(sessionID, {
      id: "unpolled-shell-job",
      source: "custom",
      content: buildUnpolledShellJobMessage(outstanding),
      priority: "high",
    })

    for (const job of outstanding) alreadyWarned.add(job.jobId)
    warnedJobs.set(sessionID, alreadyWarned)

    logger("[unpolled-shell-job] warned about outstanding detached jobs", {
      sessionID,
      jobIds: outstanding.map((job) => job.jobId),
    })
  }
}
