import { log } from "../../shared"
import {
  cloneParentWake,
  mergeParentWakeNotifications,
  resolveParentWakePromptContext,
  type ParentWakePromptContext,
  type PendingParentWake,
} from "./parent-wake-dedupe"
import { unrefTimerHandle } from "./parent-wake-timer-handle"

type ParentWakePendingQueueOptions = {
  readonly pendingRetryMs: number
  readonly enqueueNotificationForParent: (
    parentSessionID: string | undefined,
    operation: () => Promise<void>,
  ) => Promise<void>
}

export class ParentWakePendingQueue {
  private pendingParentWakes: Map<string, PendingParentWake> = new Map()
  private pendingParentWakeTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private pendingParentWakeTimerDeadlines: Map<string, number> = new Map()
  private pendingParentWakeTimersExtended: Set<string> = new Set()

  constructor(private readonly options: ParentWakePendingQueueOptions) {}

  getWakes(): Map<string, PendingParentWake> {
    return this.pendingParentWakes
  }

  getTimers(): Map<string, ReturnType<typeof setTimeout>> {
    return this.pendingParentWakeTimers
  }

  hasWake(sessionID: string): boolean {
    return this.pendingParentWakes.has(sessionID)
  }

  getWake(sessionID: string): PendingParentWake | undefined {
    return this.pendingParentWakes.get(sessionID)
  }

  deleteWake(sessionID: string): void {
    this.pendingParentWakes.delete(sessionID)
  }

  queueWake(
    sessionID: string,
    notification: string,
    promptContext: ParentWakePromptContext,
    shouldReply: boolean,
  ): void {
    const now = Date.now()
    const resolvedPromptContext = resolveParentWakePromptContext(promptContext)
    const pendingWake = this.pendingParentWakes.get(sessionID)
    if (pendingWake) {
      pendingWake.queuedAt ??= now
      const mergedNotifications = mergeParentWakeNotifications(pendingWake.notifications, notification)
      const notificationsChanged = mergedNotifications.length !== pendingWake.notifications.length
        || mergedNotifications.some((merged, index) => merged !== pendingWake.notifications[index])
      pendingWake.notifications = mergedNotifications
      pendingWake.promptContext = resolvedPromptContext
      pendingWake.shouldReply = pendingWake.shouldReply || shouldReply
      if (notificationsChanged) {
        delete pendingWake.noReplyAdmittedAt
        delete pendingWake.lastAdmitOnlyDepositAt
        delete pendingWake.noAssistantOutputRetryCount
        delete pendingWake.coalesceRequeueCount
      }
      return
    }

    this.pendingParentWakes.set(sessionID, {
      promptContext: resolvedPromptContext,
      notifications: [notification],
      shouldReply,
      queuedAt: now,
    })
  }

  requeueWake(sessionID: string, latestWake: PendingParentWake): void {
    const now = Date.now()
    const pendingWake = this.pendingParentWakes.get(sessionID)
    if (pendingWake) {
      const existingQueuedAt = pendingWake.queuedAt ?? now
      const latestQueuedAt = latestWake.queuedAt ?? now
      pendingWake.queuedAt = Math.min(existingQueuedAt, latestQueuedAt)
      pendingWake.notifications = pendingWake.notifications.reduce(
        (notifications, notification) => mergeParentWakeNotifications(notifications, notification),
        [...latestWake.notifications],
      )
      pendingWake.shouldReply = pendingWake.shouldReply || latestWake.shouldReply
      pendingWake.promptContext = latestWake.promptContext
      pendingWake.noReplyAdmittedAt ??= latestWake.noReplyAdmittedAt
      pendingWake.lastAdmitOnlyDepositAt ??= latestWake.lastAdmitOnlyDepositAt
      pendingWake.toolCallDeferralStartedAt ??= latestWake.toolCallDeferralStartedAt
      pendingWake.allowEmptyAssistantTurnRetry ||= latestWake.allowEmptyAssistantTurnRetry
      const noAssistantOutputRetryCount = Math.max(
        pendingWake.noAssistantOutputRetryCount ?? 0,
        latestWake.noAssistantOutputRetryCount ?? 0,
      )
      if (noAssistantOutputRetryCount > 0) {
        pendingWake.noAssistantOutputRetryCount = noAssistantOutputRetryCount
      }
      const coalesceRequeueCount = Math.max(
        pendingWake.coalesceRequeueCount ?? 0,
        latestWake.coalesceRequeueCount ?? 0,
      )
      if (coalesceRequeueCount > 0) {
        pendingWake.coalesceRequeueCount = coalesceRequeueCount
      }
      return
    }
    const clonedWake = cloneParentWake(latestWake)
    clonedWake.queuedAt ??= now
    this.pendingParentWakes.set(sessionID, clonedWake)
  }

  scheduleFlush(sessionID: string, operation: () => Promise<void>, delayMs?: number): void {
    const existingTimer = this.pendingParentWakeTimers.get(sessionID)
    if (existingTimer) {
      if (delayMs === undefined || this.pendingParentWakeTimersExtended.has(sessionID)) {
        return
      }
      const requestedDeadline = Date.now() + delayMs
      const existingDeadline = this.pendingParentWakeTimerDeadlines.get(sessionID)
      if (existingDeadline === undefined || requestedDeadline <= existingDeadline) {
        return
      }
      clearTimeout(existingTimer)
      this.pendingParentWakeTimersExtended.add(sessionID)
    }

    const resolvedDelayMs = delayMs ?? this.options.pendingRetryMs
    const timer = setTimeout(() => {
      this.pendingParentWakeTimers.delete(sessionID)
      this.pendingParentWakeTimerDeadlines.delete(sessionID)
      this.pendingParentWakeTimersExtended.delete(sessionID)
      void this.options.enqueueNotificationForParent(sessionID, operation).catch((error) => {
        log("[background-agent] Failed to retry pending parent wake:", { sessionID, error })
      })
    }, resolvedDelayMs)
    unrefTimerHandle(timer)

    this.pendingParentWakeTimers.set(sessionID, timer)
    this.pendingParentWakeTimerDeadlines.set(sessionID, Date.now() + resolvedDelayMs)
  }

  clearTimer(sessionID: string): void {
    const timer = this.pendingParentWakeTimers.get(sessionID)
    if (!timer) {
      return
    }

    clearTimeout(timer)
    this.pendingParentWakeTimers.delete(sessionID)
    this.pendingParentWakeTimerDeadlines.delete(sessionID)
    this.pendingParentWakeTimersExtended.delete(sessionID)
  }

  shutdown(): void {
    for (const timer of this.pendingParentWakeTimers.values()) {
      clearTimeout(timer)
    }
    this.pendingParentWakeTimers.clear()
    this.pendingParentWakeTimerDeadlines.clear()
    this.pendingParentWakeTimersExtended.clear()
    this.pendingParentWakes.clear()
  }
}
