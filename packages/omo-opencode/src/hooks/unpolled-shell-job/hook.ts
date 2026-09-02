import type { PluginInput } from "@opencode-ai/plugin"

import { log } from "../../shared"
import { resolveSessionEventID } from "../../shared/event-session-id"
import { dispatchInternalPrompt, isInternalPromptDispatchAccepted } from "../shared/prompt-async-gate"
import type { InternalPromptDispatchResult } from "@oh-my-opencode/utils/prompt-async-gate/types"
import { shouldPromptAfterSessionIdle } from "../shared/session-idle-settle"

import { buildUnpolledShellJobMessage } from "./message"
import { forgetSession, getOutstandingJobs } from "./tracker"

const HOOK_NAME = "unpolled-shell-job"

/**
 * Minimum gap between two continuation prompts for the same session.
 *
 * The guard must keep firing while a job is outstanding — going permanently quiet after
 * one attempt guarantees the stall it exists to prevent — but re-prompting on every idle
 * would spin. A cooldown keeps it insistent without spamming.
 */
export const NUDGE_COOLDOWN_MS = 60_000

type UnpolledShellJobEvent = {
  readonly event: {
    readonly type: string
    readonly properties?: unknown
  }
}

type UnpolledShellJobOptions = {
  readonly idleSettleMs?: number
  readonly now?: () => number
  /** Injected in tests; `mock.module` would leak globally across bun's test process. */
  readonly dispatchPrompt?: typeof dispatchInternalPrompt
  readonly isDispatchAccepted?: typeof isInternalPromptDispatchAccepted
  readonly shouldPrompt?: typeof shouldPromptAfterSessionIdle
}

/**
 * `isInternalPromptDispatchAccepted` counts `"queued"` as accepted, but the
 * `"already-delivered"` coalesce shape means the prompt was DISCARDED inside the semantic
 * dedupe hold. This warning is byte-identical on every fire while the same job set is
 * outstanding, so it is the exact prompt that shape suppresses. Arming the cooldown on it
 * would silence the guard for a message the session never received.
 */
function isDiscardedByCoalesce(result: InternalPromptDispatchResult): boolean {
  return result.status === "queued" && result.coalesceKind === "already-delivered"
}

const lastNudgedAt = new Map<string, number>()
const inFlight = new Set<string>()

/** @internal For testing only */
export function _resetNudgeStateForTesting(): void {
  lastNudgedAt.clear()
  inFlight.clear()
}

export function forgetNudgeState(sessionID: string): void {
  lastNudgedAt.delete(sessionID)
  inFlight.delete(sessionID)
}

export function createUnpolledShellJobHook(
  ctx: PluginInput,
  options: UnpolledShellJobOptions = {},
): (input: UnpolledShellJobEvent) => Promise<void> {
  const now = options.now ?? (() => Date.now())
  const dispatchPrompt = options.dispatchPrompt ?? dispatchInternalPrompt
  const isDispatchAccepted = options.isDispatchAccepted ?? isInternalPromptDispatchAccepted
  const shouldPrompt = options.shouldPrompt ?? shouldPromptAfterSessionIdle

  return async ({ event }) => {
    const sessionID = resolveSessionEventID(event.properties)
    if (sessionID === undefined) return

    if (event.type === "session.deleted") {
      forgetSession(sessionID)
      forgetNudgeState(sessionID)
      return
    }
    if (event.type !== "session.idle") return

    const outstanding = getOutstandingJobs(sessionID)
    if (outstanding.length === 0) return

    if (inFlight.has(sessionID)) return
    const previous = lastNudgedAt.get(sessionID)
    if (previous !== undefined && now() - previous < NUDGE_COOLDOWN_MS) return

    inFlight.add(sessionID)
    try {
      // The session may have resumed between the idle event and this dispatch.
      if (!(await shouldPrompt(ctx.client, sessionID, options.idleSettleMs))) {
        log(`[${HOOK_NAME}] Skipped; session is active again`, { sessionID })
        return
      }

      const promptResult = await dispatchPrompt({
        mode: "async",
        client: ctx.client,
        sessionID,
        source: `${HOOK_NAME}:idle-poll-reminder`,
        ...(options.idleSettleMs === undefined ? {} : { settleMs: options.idleSettleMs }),
        queueBehavior: "defer",
        input: {
          path: { id: sessionID },
          body: { parts: [{ type: "text", text: buildUnpolledShellJobMessage(outstanding) }] },
        },
      })

      if (!isDispatchAccepted(promptResult) || isDiscardedByCoalesce(promptResult)) {
        log(`[${HOOK_NAME}] Continuation dispatch not accepted`, {
          sessionID,
          status: promptResult.status,
        })
        return
      }

      lastNudgedAt.set(sessionID, now())
      log(`[${HOOK_NAME}] Prompted session to poll its detached shell jobs`, {
        sessionID,
        jobIds: outstanding.map((job) => job.jobId),
      })
    } finally {
      inFlight.delete(sessionID)
    }
  }
}
