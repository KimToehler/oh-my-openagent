import { log } from "../../shared"
import type { BackgroundTaskConfig } from "../../config/schema"
import type { BackgroundTask } from "./types"
import type { ConcurrencyManager } from "./concurrency"
import type { OpencodeClient } from "./opencode-client"

import {
  DEFAULT_BLOCKED_EXPIRY_MS,
  DEFAULT_MESSAGE_STALENESS_TIMEOUT_MS,
  DEFAULT_SESSION_GONE_TIMEOUT_MS,
  DEFAULT_STALE_TIMEOUT_MS,
  MAX_ACTIVITY_UNAVAILABLE_POLLS,
  MIN_RUNTIME_BEFORE_STALE_MS,
  TERMINAL_TASK_TTL_MS,
  TASK_TTL_MS,
} from "./constants"
import { abortWithTimeout } from "./abort-with-timeout"
import { isTaskBlocked } from "./blocked-state"
import { removeTaskToastTracking } from "./remove-task-toast-tracking"
import { checkSessionExistence, MIN_SESSION_GONE_POLLS } from "./session-existence"

import { isActiveSessionStatus } from "./session-status-classifier"
import { getSessionActivityFromClient, type SessionActivityResolver } from "./session-activity"
import { refreshTaskActivityFromSession } from "./task-activity-refresh"

const TERMINAL_TASK_STATUSES = new Set<BackgroundTask["status"]>([
  "completed",
  "error",
  "cancelled",
  "interrupt",
])

export function pruneStaleTasksAndNotifications(args: {
  tasks: Map<string, BackgroundTask>
  notifications: Map<string, BackgroundTask[]>
  onTaskPruned: (taskId: string, task: BackgroundTask, errorMessage: string) => void
  taskTtlMs?: number
  blockedExpiryMs?: number
  sessionStatuses?: SessionStatusMap
}): void {
  const { tasks, notifications, onTaskPruned } = args
  const effectiveTtl = args.taskTtlMs ?? TASK_TTL_MS
  const now = Date.now()
  const tasksWithPendingNotifications = new Set<string>()

  for (const queued of notifications.values()) {
    for (const task of queued) {
      tasksWithPendingNotifications.add(task.id)
    }
  }

  for (const [taskId, task] of tasks.entries()) {
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      if (tasksWithPendingNotifications.has(taskId)) continue

      const blockedAt = task.blockedAt?.getTime()
      const blockedExpiryMs = args.blockedExpiryMs ?? DEFAULT_BLOCKED_EXPIRY_MS
      if (isTaskBlocked(task) && blockedAt !== undefined && now - blockedAt < blockedExpiryMs) continue

      const completedAt = task.completedAt?.getTime()
      if (!completedAt) continue

      const age = now - completedAt
      if (age <= TERMINAL_TASK_TTL_MS) continue

      removeTaskToastTracking(taskId)
      tasks.delete(taskId)
      continue
    }

    if (task.teamRunId) {
      continue
    }

    const sessionStatus = task.sessionId ? args.sessionStatuses?.[task.sessionId]?.type : undefined
    if (task.status === "running" && sessionStatus !== undefined && isActiveSessionStatus(sessionStatus)) {
      continue
    }

    const lastActivity = task.status === "running" && task.progress?.lastUpdate
      ? task.progress.lastUpdate.getTime()
      : undefined
    const timestamp = task.status === "pending"
      ? task.queuedAt?.getTime()
      : (lastActivity ?? task.startedAt?.getTime())

    if (!timestamp) continue

    const age = now - timestamp
    if (age <= effectiveTtl) continue

    const ttlMinutes = Math.round(effectiveTtl / 60000)
    const inactivitySeconds = Math.round(age / 1000)
    const errorMessage = task.status === "pending"
      ? `Task timed out while queued (${ttlMinutes} minutes)`
      : (task.progress?.toolCalls ?? 0) > 0
        ? `Task stuck with output present after ${inactivitySeconds}s of inactivity (${ttlMinutes} minute TTL)`
        : `Task genuinely inactive after ${inactivitySeconds}s (${ttlMinutes} minute TTL)`

    onTaskPruned(taskId, task, errorMessage)
  }

  for (const [sessionID, queued] of notifications.entries()) {
    if (queued.length === 0) {
      notifications.delete(sessionID)
      continue
    }

    const validNotifications = queued.filter((task) => {
      if (!task.startedAt) return false
      const age = now - task.startedAt.getTime()
      return age <= effectiveTtl
    })

    if (validNotifications.length === 0) {
      notifications.delete(sessionID)
    } else if (validNotifications.length !== queued.length) {
      notifications.set(sessionID, validNotifications)
    }
  }
}

export type SessionStatusMap = Record<string, { type: string }>

/**
 * A failed activity lookup defers the stale interrupt, because a transient API
 * error must not kill a healthy lane. Unbounded, that deferral is also how a
 * hung provider stream survives forever: the session stays `busy`, the lookup
 * keeps failing, and `staleTimeoutMs` is never reached. Cap the consecutive
 * deferrals so an unreachable session eventually loses its reprieve.
 *
 * Returns true while the task may still be deferred.
 */
function deferForUnavailableActivity(task: BackgroundTask): boolean {
  const misses = (task.consecutiveActivityUnavailablePolls ?? 0) + 1
  task.consecutiveActivityUnavailablePolls = misses
  return misses < MAX_ACTIVITY_UNAVAILABLE_POLLS
}

async function interruptStaleTask(args: {
  task: BackgroundTask
  client: OpencodeClient
  concurrencyManager: ConcurrencyManager
  notifyParentSession: (task: BackgroundTask) => Promise<void>
  onTaskInterrupted: (task: BackgroundTask) => void
  sessionID: string
  reason: string
  staleMinutes: number
  timeoutConfigKey: "messageStalenessTimeoutMs" | "sessionGoneTimeoutMs" | "staleTimeoutMs"
  errorSuffix: string
  logReason: string
  claimTaskInterruption: (taskId: string) => boolean
  releaseTaskInterruption: (taskId: string) => void
}): Promise<void> {
  const {
    task,
    client,
    concurrencyManager,
    notifyParentSession,
    onTaskInterrupted,
    sessionID,
    reason,
    staleMinutes,
    timeoutConfigKey,
    errorSuffix,
    logReason,
    claimTaskInterruption,
    releaseTaskInterruption,
  } = args

  if (!claimTaskInterruption(task.id)) return
  try {
  const aborted = await abortWithTimeout(client, sessionID)
  if (!aborted) {
    log("[background-agent] Task stale interruption skipped because session abort failed:", {
      taskId: task.id,
      sessionID,
      reason,
    })
    return
  }

  if (task.status !== "running" || task.sessionId !== sessionID) return

  task.status = "cancelled"
  task.error = `Stale timeout (${reason} for ${staleMinutes}min${errorSuffix}). This is a FINAL cancellation - do NOT create a replacement task. If the timeout is too short, increase 'background_task.${timeoutConfigKey}' in .omo/omo.jsonc.`
  task.completedAt = new Date()

  if (task.concurrencyKey) {
    concurrencyManager.release(task.concurrencyKey)
    task.concurrencyKey = undefined
  }

  onTaskInterrupted(task)
  log(`[background-agent] Task ${task.id} interrupted: ${logReason}`)

  try {
    await notifyParentSession(task)
  } catch (err) {
    log("[background-agent] Error in notifyParentSession for stale task:", { taskId: task.id, error: err })
  }
  } finally {
    releaseTaskInterruption(task.id)
  }
}

export async function checkAndInterruptStaleTasks(args: {
  tasks: Iterable<BackgroundTask>
  client: OpencodeClient
  directory?: string
  config: BackgroundTaskConfig | undefined
  concurrencyManager: ConcurrencyManager
  notifyParentSession: (task: BackgroundTask) => Promise<void>
  sessionStatuses?: SessionStatusMap
  onTaskInterrupted?: (task: BackgroundTask) => void
  getSessionActivity?: SessionActivityResolver
  claimTaskInterruption?: (taskId: string) => boolean
  releaseTaskInterruption?: (taskId: string) => void
}): Promise<void> {
  const {
    tasks,
    client,
    directory,
    config,
    concurrencyManager,
    notifyParentSession,
    sessionStatuses,
    onTaskInterrupted = (task) => removeTaskToastTracking(task.id),
    claimTaskInterruption = () => true,
    releaseTaskInterruption = () => {},
  } = args
  const staleTimeoutMs = config?.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS
  const sessionGoneTimeoutMs = config?.sessionGoneTimeoutMs ?? DEFAULT_SESSION_GONE_TIMEOUT_MS
  const now = Date.now()

  const messageStalenessMs = config?.messageStalenessTimeoutMs ?? DEFAULT_MESSAGE_STALENESS_TIMEOUT_MS
  const getSessionActivity = args.getSessionActivity
    ?? ((id: string) => getSessionActivityFromClient(client, id, directory))
  const staleInterruptions: Array<Promise<void>> = []

  for (const task of tasks) {
    if (task.status !== "running") continue

    const startedAt = task.startedAt
    const sessionID = task.sessionId
    if (!startedAt || !sessionID) continue

    const sessionStatus = sessionStatuses?.[sessionID]?.type
    const sessionMissing = sessionStatuses !== undefined && sessionStatus === undefined
    const runtime = now - startedAt.getTime()

    if (sessionMissing) {
      task.consecutiveMissedPolls = (task.consecutiveMissedPolls ?? 0) + 1
    } else if (sessionStatuses !== undefined) {
      task.consecutiveMissedPolls = 0
    }

    const sessionGone = sessionMissing && (task.consecutiveMissedPolls ?? 0) >= MIN_SESSION_GONE_POLLS
    const shouldSkipInactivityTimeout = task.teamRunId !== undefined && !sessionGone
    const shouldRefreshFromSessionActivity = !sessionGone
      && sessionStatus !== undefined
      && isActiveSessionStatus(sessionStatus)

    if (!task.progress?.lastUpdate) {
      if (shouldSkipInactivityTimeout) continue
      if (sessionMissing && !sessionGone) continue
      const effectiveTimeout = sessionGone ? sessionGoneTimeoutMs : messageStalenessMs
      if (runtime <= effectiveTimeout) continue

      if (shouldRefreshFromSessionActivity) {
        const activityRefresh = await refreshTaskActivityFromSession(task, getSessionActivity)
        if (activityRefresh.type === "unavailable" && deferForUnavailableActivity(task)) continue
        if (activityRefresh.type !== "unavailable") task.consecutiveActivityUnavailablePolls = 0
        if (activityRefresh.type === "activity" && now - activityRefresh.activityTime <= effectiveTimeout) continue
      }

      if (sessionGone) {
        const existence = await checkSessionExistence(client, sessionID, directory)
        if (existence === "exists") {
          task.consecutiveMissedPolls = 0
          continue
        }
        if (existence === "unknown") continue
      }

      const staleMinutes = Math.round(runtime / 60000)
      const reason = sessionGone ? "session gone from status registry" : "no activity"
      staleInterruptions.push(
        interruptStaleTask({
          task,
          client,
          concurrencyManager,
          notifyParentSession,
          onTaskInterrupted,
          sessionID,
          reason,
          staleMinutes,
          timeoutConfigKey: sessionGone ? "sessionGoneTimeoutMs" : "messageStalenessTimeoutMs",
          errorSuffix: " since start",
          logReason: "no progress since start",
          claimTaskInterruption,
          releaseTaskInterruption,
        }),
      )
      continue
    }

    if (shouldSkipInactivityTimeout) continue

    if (runtime < MIN_RUNTIME_BEFORE_STALE_MS) continue

    let timeSinceLastUpdate = now - task.progress.lastUpdate.getTime()
    const effectiveStaleTimeout = sessionGone ? sessionGoneTimeoutMs : staleTimeoutMs
    if (timeSinceLastUpdate <= effectiveStaleTimeout) continue

    if (shouldRefreshFromSessionActivity) {
      const activityRefresh = await refreshTaskActivityFromSession(task, getSessionActivity)
      if (activityRefresh.type === "unavailable" && deferForUnavailableActivity(task)) continue
      if (activityRefresh.type !== "unavailable") task.consecutiveActivityUnavailablePolls = 0
      const refreshedLastUpdate = task.progress?.lastUpdate.getTime()
        ?? (activityRefresh.type === "activity" ? activityRefresh.activityTime : undefined)
      if (refreshedLastUpdate !== undefined && now - refreshedLastUpdate <= effectiveStaleTimeout) continue
      if (refreshedLastUpdate !== undefined) {
        timeSinceLastUpdate = now - refreshedLastUpdate
      }
    }

    if (task.status !== "running") continue

    if (sessionGone) {
      const existence = await checkSessionExistence(client, sessionID, directory)
      if (existence === "exists") {
        task.consecutiveMissedPolls = 0
        continue
      }
      if (existence === "unknown") continue
    }

    const staleMinutes = Math.round(timeSinceLastUpdate / 60000)
    const reason = sessionGone ? "session gone from status registry" : "no activity"
    staleInterruptions.push(
      interruptStaleTask({
        task,
        client,
        concurrencyManager,
        notifyParentSession,
        onTaskInterrupted,
        sessionID,
        reason,
        staleMinutes,
        timeoutConfigKey: sessionGone ? "sessionGoneTimeoutMs" : "staleTimeoutMs",
        errorSuffix: "",
        logReason: "stale timeout",
        claimTaskInterruption,
        releaseTaskInterruption,
      }),
    )
  }

  if (staleInterruptions.length > 0) {
    await Promise.all(staleInterruptions)
  }
}
