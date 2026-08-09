type Timer = ReturnType<typeof setTimeout>

type BlockedEscalationOptions = {
  readonly rewakeMs: number
  readonly expiryMs: number
  readonly onReminder: (taskId: string) => void | Promise<void>
  readonly onExpiry: (taskId: string) => void
}

type BlockedEscalationTimers = {
  readonly reminder: Timer
  readonly expiry: Timer
}

export function buildBlockedReminderNotification(notification: string, waitedMs: number): string {
  const waitedMinutes = Math.floor(waitedMs / 60_000)
  const marker = `[BACKGROUND TASK BLOCKED] (reminder 1 of 1, waiting ${waitedMinutes}m)`
  return notification.replace("[BACKGROUND TASK BLOCKED]", `[BACKGROUND TASK BLOCKED]\n${marker}`)
}

export class BlockedEscalation {
  private readonly timers = new Map<string, BlockedEscalationTimers>()

  constructor(private readonly options: BlockedEscalationOptions) {}

  arm(taskId: string): void {
    this.cancel(taskId)
    const reminder = setTimeout(() => {
      if (!this.timers.has(taskId)) return
      void this.options.onReminder(taskId)
    }, this.options.rewakeMs)
    const expiry = setTimeout(() => {
      if (!this.claim(taskId)) return
      this.options.onExpiry(taskId)
    }, this.options.expiryMs)
    this.timers.set(taskId, { reminder, expiry })
  }

  claim(taskId: string): boolean {
    const timers = this.timers.get(taskId)
    if (!timers) return false
    clearTimeout(timers.reminder)
    clearTimeout(timers.expiry)
    this.timers.delete(taskId)
    return true
  }

  cancel(taskId: string): void {
    this.claim(taskId)
  }

  shutdown(): void {
    for (const taskId of this.timers.keys()) this.cancel(taskId)
  }
}
