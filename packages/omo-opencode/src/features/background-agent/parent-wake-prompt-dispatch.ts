import {
  createInternalAgentTextPart,
  isAmbiguousPostDispatchPromptFailure,
  log,
  withInternalNoReplyMarker,
} from "../../shared"
import { dispatchInternalPrompt, isInternalPromptDispatchAccepted } from "../../hooks/shared/prompt-async-gate"
import {
  DEFAULT_PROMPT_ASYNC_POST_DISPATCH_HOLD_MS,
  DEFAULT_PROMPT_SEMANTIC_DEDUPE_HOLD_MS,
} from "../../shared/prompt-async-gate/timing"
import type { InternalPromptDispatchResult } from "../../shared/prompt-async-gate/types"
import type { PromptDispatchClient } from "@oh-my-opencode/utils/prompt-async-gate/types"
import { getErrorText } from "./error-classifier"
import {
  createEmptyAssistantTurnRetryDedupeKey,
  createNoAssistantOutputRetryDedupeKey,
} from "./parent-wake-history-state"
import { cloneParentWake, isRedundantParentWake, type PendingParentWake } from "./parent-wake-dedupe"
import type { ToolWaitDeferralDecision } from "./parent-wake-session-history"

// Explicit termination bound for coalesce-originated requeues. An
// "already-delivered" coalesce means the gate DISCARDED this wake, so
// recording it as dispatched would lose it; requeue instead, but only this
// many times per wake so the loop terminates by invariant, not by the
// semantic-dedupe hold happening to expire. Deliberately distinct from
// MAX_NO_ASSISTANT_OUTPUT_RETRIES (parent-wake-window-recovery.ts): that
// budget covers post-dispatch window recovery, this one covers pre-dispatch
// gate discards.
export const MAX_COALESCE_REQUEUE_ATTEMPTS = 3
// The gate's semantic dedupe hold is never refreshed on a coalesce, so the
// requeue budget only works if it can outlast that hold: otherwise every
// retry lands inside the hold, the cap exhausts, and the wake is recorded as
// dispatched without ever reaching the client. Derive the per-attempt delay
// from the hold so the invariant
//   MAX_COALESCE_REQUEUE_ATTEMPTS * COALESCE_REQUEUE_FLUSH_DELAY_MS
//     >= DEFAULT_PROMPT_SEMANTIC_DEDUPE_HOLD_MS
// survives any future edit to timing.ts instead of holding by coincidence.
// The post-dispatch hold is folded in as slack so the budget clears the
// semantic hold even if the first coalesce is observed at the instant the
// record is written and flush timers fire early.
export const COALESCE_REQUEUE_FLUSH_DELAY_MS = Math.ceil(
  (DEFAULT_PROMPT_SEMANTIC_DEDUPE_HOLD_MS + DEFAULT_PROMPT_ASYNC_POST_DISPATCH_HOLD_MS) /
    MAX_COALESCE_REQUEUE_ATTEMPTS,
)

// The gate discarded this prompt as a duplicate of one already delivered.
// An "in-flight" coalesce is NOT discarded: an identical prompt is still on
// its way, so treating it as dispatched is correct.
export function isDiscardedCoalesceDispatchResult(result: InternalPromptDispatchResult): boolean {
  return result.status === "queued" && result.coalesceKind === "already-delivered"
}

type ParentWakePromptDispatchInput = {
  readonly client: PromptDispatchClient
  readonly directory: string
  readonly sessionID: string
  readonly latestWake: PendingParentWake
  readonly forceNoReply?: boolean
  readonly retainPendingWake?: boolean
  readonly skipPromptGateStatusCheck?: boolean
  readonly emptyAssistantTurnRetry: boolean
  readonly toolWaitDecision: ToolWaitDeferralDecision
  readonly getDispatchedWake: () => PendingParentWake | undefined
  readonly hasRecordedPromptAfterDispatch: (wake: PendingParentWake) => Promise<boolean>
  readonly trackDispatchedWake: (wake: PendingParentWake, dispatchedAt: number) => void
  readonly requeueWake: (wake: PendingParentWake) => void
  readonly scheduleFlush: (delayMs?: number) => void
}

export async function sendParentWakePrompt(input: ParentWakePromptDispatchInput): Promise<void> {
  const notificationContent = input.latestWake.notifications.join("\n\n")
  let dispatchStartedAt = Date.now()
  try {
    dispatchStartedAt = Date.now()
    const promptResult = await dispatchInternalPrompt({
      mode: "async",
      client: input.client,
      sessionID: input.sessionID,
      source: "background-agent-parent-wake",
      ...(input.emptyAssistantTurnRetry
        ? { dedupeKey: createEmptyAssistantTurnRetryDedupeKey(input.latestWake) }
        : (input.latestWake.noAssistantOutputRetryCount ?? 0) > 0
          ? { dedupeKey: createNoAssistantOutputRetryDedupeKey(input.latestWake) }
          : {}),
      settleMs: 0,
      queueBehavior: "defer",
      checkStatus: input.forceNoReply !== true && input.skipPromptGateStatusCheck !== true,
      checkToolState: input.forceNoReply !== true && !input.toolWaitDecision.skipPromptGateToolStateCheck,
      input: {
        path: { id: input.sessionID },
        body: {
          noReply: input.forceNoReply === true || !input.latestWake.shouldReply,
          ...input.latestWake.promptContext,
          parts: [
            input.forceNoReply === true || !input.latestWake.shouldReply
              ? withInternalNoReplyMarker(createInternalAgentTextPart(notificationContent))
              : createInternalAgentTextPart(notificationContent),
          ],
        },
        query: { directory: input.directory },
      },
    })
    if (promptResult.status === "failed") {
      if (isAmbiguousPostDispatchPromptFailure(promptResult)) {
        const dispatchedWake = cloneParentWake(input.latestWake)
        dispatchedWake.dispatchedAt = dispatchStartedAt
        if (await input.hasRecordedPromptAfterDispatch(dispatchedWake)) {
          markRetainedNoReplyAdmission(input, dispatchStartedAt)
          input.trackDispatchedWake(createTrackedDispatchedWake(input.latestWake, input.forceNoReply), dispatchStartedAt)
          log("[background-agent] Treated failed parent wake prompt as accepted after observing session history:", {
            sessionID: input.sessionID,
            error: promptResult.error,
          })
          return
        }
      }
      throw promptResult.error
    }
    if (promptResult.status === "reserved" && promptResult.reservedBy === "background-agent-parent-wake") {
      const dispatchedWake = input.getDispatchedWake()
      if (dispatchedWake && isRedundantParentWake(input.latestWake, dispatchedWake)) {
        log("[background-agent] Suppressed duplicate parent wake during promptAsync gate hold:", {
          sessionID: input.sessionID,
        })
        return
      }
      input.requeueWake(input.latestWake)
      input.scheduleFlush(2_000)
      log("[background-agent] Requeued parent wake flush reserved by promptAsync gate hold:", {
        sessionID: input.sessionID,
      })
      return
    }
    if (isDiscardedCoalesceDispatchResult(promptResult) && !isAdmitOnlyDispatch(input)) {
      const coalesceRequeueCount = input.latestWake.coalesceRequeueCount ?? 0
      if (coalesceRequeueCount < MAX_COALESCE_REQUEUE_ATTEMPTS) {
        input.latestWake.coalesceRequeueCount = coalesceRequeueCount + 1
        input.requeueWake(input.latestWake)
        input.scheduleFlush(COALESCE_REQUEUE_FLUSH_DELAY_MS)
        log("[background-agent] Requeued parent wake discarded as an already-delivered coalesce:", {
          sessionID: input.sessionID,
          coalesceRequeueCount: coalesceRequeueCount + 1,
        })
        return
      }
      log("[background-agent] Coalesce requeue budget exhausted; recording parent wake as dispatched:", {
        sessionID: input.sessionID,
        coalesceRequeueCount,
      })
    }
    if (!isInternalPromptDispatchAccepted(promptResult)) {
      input.requeueWake(input.latestWake)
      input.scheduleFlush()
      log("[background-agent] Deferred parent wake skipped by promptAsync gate:", {
        sessionID: input.sessionID,
        status: promptResult.status,
      })
      return
    }
    log("[background-agent] Sent deferred parent wake:", { sessionID: input.sessionID })
    delete input.latestWake.allowEmptyAssistantTurnRetry
    delete input.latestWake.coalesceRequeueCount
    markRetainedNoReplyAdmission(input, dispatchStartedAt)
    input.trackDispatchedWake(createTrackedDispatchedWake(input.latestWake, input.forceNoReply), dispatchStartedAt)
  } catch (error) {
    const errorText = error instanceof Error ? `${error.name}: ${error.message}` : getErrorText(error) || String(error)
    input.requeueWake(input.latestWake)
    input.scheduleFlush()
    log("[background-agent] Failed to send deferred parent wake:", { sessionID: input.sessionID, error: errorText })
  }
}

// The admit-only path deposits a retained noReply admission and MUST NOT
// requeue on a coalesce: requeuing would re-deposit identical noReply text and
// skip the markRetainedNoReplyAdmission write that #4874/#5086 depend on.
function isAdmitOnlyDispatch(input: ParentWakePromptDispatchInput): boolean {
  return input.forceNoReply === true && input.retainPendingWake === true
}

function markRetainedNoReplyAdmission(input: ParentWakePromptDispatchInput, dispatchStartedAt: number): void {
  if (input.retainPendingWake !== true || input.forceNoReply !== true) {
    return
  }
  // Two distinct markers so an admit-only deposit can never alias a reply
  // admission (issues #4874/#5086): noReplyAdmittedAt means a REPLY-REQUIRED
  // wake was admitted as noReply and its reply is still owed;
  // lastAdmitOnlyDepositAt only restarts the bounded re-admission ceiling for
  // retained shouldReply:false deposits.
  if (input.latestWake.shouldReply) {
    input.latestWake.noReplyAdmittedAt = dispatchStartedAt
  }
  input.latestWake.lastAdmitOnlyDepositAt = dispatchStartedAt
  input.scheduleFlush()
}

function createTrackedDispatchedWake(wake: PendingParentWake, forceNoReply: boolean | undefined): PendingParentWake {
  if (forceNoReply !== true || !wake.shouldReply) {
    return wake
  }

  return {
    ...cloneParentWake(wake),
    shouldReply: false,
  }
}
