import { log } from "../../shared"
import type { PendingParentWake } from "./parent-wake-dedupe"
import type { ParentWakeDispatchedTracker } from "./parent-wake-dispatched-tracker"
import type { ParentWakeSessionInspector } from "./parent-wake-session-inspector"

const MAX_NO_ASSISTANT_OUTPUT_RETRIES = 1

type ParentWakeWindowRecoveryInput = {
  readonly sessionID: string
  readonly wake: PendingParentWake
  readonly dispatchedTracker: ParentWakeDispatchedTracker
  readonly sessionInspector: ParentWakeSessionInspector
  readonly requeueWake: (wake: PendingParentWake) => void
  readonly scheduleFlush: () => void
}

export async function handleDispatchedParentWakeWindowElapsed(
  input: ParentWakeWindowRecoveryInput,
): Promise<void> {
  const currentWake = input.dispatchedTracker.getWake(input.sessionID)
  if (!currentWake || currentWake.dispatchedAt !== input.wake.dispatchedAt) {
    return
  }

  if (await input.sessionInspector.hasAssistantOrToolOutputAfterDispatchedWake(input.sessionID, input.wake)) {
    input.dispatchedTracker.clearWake(input.sessionID)
    log("[background-agent] Cleared dispatched parent wake after observing assistant output:", {
      sessionID: input.sessionID,
    })
    return
  }

  // A noReply dispatch is a DEPOSIT, not a turn: it is accepted precisely so it
  // does NOT fork an assistant reply. Absence of assistant output is therefore
  // its success condition, never evidence of a lost dispatch, so the no-output
  // retry below cannot apply. Retrying here re-injected the identical
  // notification text into the parent session (the tracked wake is cloned with
  // shouldReply:false for admit-only deposits, so this covers both a plain
  // shouldReply:false wake and an admit-only deposit of a reply-required one).
  // Liveness for a retained reply-required wake is owned by the pending-queue
  // flush machinery, which keeps its own entry and its own scheduled flush.
  if (!input.wake.shouldReply) {
    input.dispatchedTracker.clearWake(input.sessionID)
    log("[background-agent] Cleared dispatched noReply parent wake without retry:", {
      sessionID: input.sessionID,
    })
    return
  }

  const retryCount = input.wake.noAssistantOutputRetryCount ?? 0
  if (retryCount >= MAX_NO_ASSISTANT_OUTPUT_RETRIES) {
    input.dispatchedTracker.clearWake(input.sessionID)
    log("[background-agent] Stopped retrying parent wake after repeated no-output dispatch:", {
      sessionID: input.sessionID,
      retryCount,
    })
    return
  }

  input.dispatchedTracker.clearWake(input.sessionID)
  input.wake.noAssistantOutputRetryCount = retryCount + 1
  input.requeueWake(input.wake)
  input.scheduleFlush()
  log("[background-agent] Requeued dispatched parent wake after no assistant output:", {
    sessionID: input.sessionID,
    retryCount: input.wake.noAssistantOutputRetryCount,
  })
}

export function logParentWakeWindowRecoveryError(sessionID: string, error: unknown): void {
  const errorText = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  log("[background-agent] Failed to inspect dispatched parent wake after recovery window:", {
    sessionID,
    error: errorText,
  })
}

export function rescheduleParentWakeWindowRecoveryAfterError(
  sessionID: string,
  wake: PendingParentWake,
  dispatchedTracker: ParentWakeDispatchedTracker,
): void {
  const currentWake = dispatchedTracker.getWake(sessionID)
  if (!currentWake || currentWake.dispatchedAt !== wake.dispatchedAt) {
    return
  }
  dispatchedTracker.refreshWakeTimer(sessionID)
}
