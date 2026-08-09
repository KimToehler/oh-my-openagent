import type { BackgroundTask } from "./types"

export function isTaskBlocked(task: BackgroundTask): boolean {
  return task.blockedAt !== undefined
}
