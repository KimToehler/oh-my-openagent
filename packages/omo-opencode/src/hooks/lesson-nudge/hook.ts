import { getMainSessionID, subagentSessions } from "../../features/claude-code-session-state"
import { contextCollector, type ContextCollector } from "../../features/context-injector/collector"
import { log } from "../../shared"
import { resolveSessionEventID } from "../../shared/event-session-id"
import { buildLessonNudgeMessage } from "./message"

type LessonNudgeEvent = {
  readonly event: {
    readonly type: string
    readonly properties?: unknown
  }
}

type LessonNudgeLogger = (message: string, data?: Record<string, unknown>) => void

const registeredSessions = new Set<string>()

/** @internal For testing only */
export function _resetForTesting(): void {
  registeredSessions.clear()
}

export function createLessonNudgeHook(
  collector: ContextCollector = contextCollector,
  logger: LessonNudgeLogger = log,
): (input: LessonNudgeEvent) => Promise<void> {
  return async ({ event }) => {
    const sessionID = resolveSessionEventID(event.properties)
    if (sessionID === undefined) return

    if (event.type === "session.deleted") {
      registeredSessions.delete(sessionID)
      return
    }
    if (event.type !== "session.idle") return
    if (subagentSessions.has(sessionID)) return

    const mainSessionID = getMainSessionID()
    if (mainSessionID !== undefined && mainSessionID !== sessionID) return
    if (registeredSessions.has(sessionID)) return

    const content = buildLessonNudgeMessage()
    collector.register(sessionID, {
      id: "lesson-nudge",
      source: "custom",
      content,
      priority: "normal",
    })
    registeredSessions.add(sessionID)
    logger("[lesson-nudge] registered nudge", {
      sessionID,
      contentLength: content.length,
    })
  }
}
