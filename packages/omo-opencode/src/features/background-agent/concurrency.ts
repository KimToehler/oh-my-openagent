import type { BackgroundTaskConfig } from "../../config/schema"

/**
 * Queue entry with settled-flag pattern to prevent double-resolution.
 *
 * The settled flag ensures that cancelWaiters() doesn't reject
 * an entry that was already resolved by release().
 */
interface QueueEntry {
  taskId?: string
  resolve: () => void
  rawReject: (error: Error) => void
  settled: boolean
  timeout?: ReturnType<typeof setTimeout>
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 600_000

export class ConcurrencyManager {
  private config?: BackgroundTaskConfig
  private counts: Map<string, number> = new Map()
  private queues: Map<string, QueueEntry[]> = new Map()

  constructor(config?: BackgroundTaskConfig) {
    this.config = config
  }

  getConcurrencyLimit(model: string): number {
    const modelLimit = this.config?.modelConcurrency?.[model]
    if (modelLimit !== undefined) {
      return modelLimit === 0 ? Infinity : modelLimit
    }
    const provider = model.split('/')[0]
    const providerLimit = this.config?.providerConcurrency?.[provider]
    if (providerLimit !== undefined) {
      return providerLimit === 0 ? Infinity : providerLimit
    }
    const defaultLimit = this.config?.defaultConcurrency
    if (defaultLimit !== undefined) {
      return defaultLimit === 0 ? Infinity : defaultLimit
    }
    return 5
  }

  getConcurrencyKey(model: string): string {
    if (this.config?.modelConcurrency?.[model] !== undefined) {
      return model
    }

    const provider = model.split('/')[0]
    if (provider && this.config?.providerConcurrency?.[provider] !== undefined) {
      return provider
    }

    return model
  }

  async acquire(model: string, taskId?: string): Promise<void> {
    const key = this.getConcurrencyKey(model)
    const limit = this.getConcurrencyLimit(model)
    if (limit === Infinity) {
      return
    }

    const current = this.counts.get(key) ?? 0
    if (current < limit) {
      this.counts.set(key, current + 1)
      return
    }

    return new Promise<void>((resolve, reject) => {
      const queue = this.queues.get(key) ?? []

      const entry: QueueEntry = {
        taskId,
        resolve: () => {
          if (entry.settled) return
          entry.settled = true
          if (entry.timeout) clearTimeout(entry.timeout)
          resolve()
        },
        rawReject: reject,
        settled: false,
      }

      const waitTimeoutMs = this.getAcquireTimeoutMs()
      if (waitTimeoutMs !== Infinity) {
        // A stranded slot would otherwise park this waiter forever: the task
        // never reaches startTask, so it has no session for the stale/session-gone
        // watchdogs to reap and stays `pending` indefinitely. Failing the acquire
        // surfaces it as an errored task instead.
        entry.timeout = setTimeout(() => {
          if (entry.settled) return
          entry.settled = true
          const index = queue.indexOf(entry)
          if (index !== -1) queue.splice(index, 1)
          reject(new Error(
            `Timed out after ${waitTimeoutMs}ms waiting for a concurrency slot on "${key}". ` +
            `This usually means a slot was not released by a previous task.`
          ))
        }, waitTimeoutMs)
        entry.timeout.unref?.()
      }

      queue.push(entry)
      this.queues.set(key, queue)
    })
  }

  private getAcquireTimeoutMs(): number {
    const configured = this.config?.acquireTimeoutMs
    if (configured === undefined) return DEFAULT_ACQUIRE_TIMEOUT_MS
    return configured === 0 ? Infinity : configured
  }

  release(model: string): void {
    const key = this.getConcurrencyKey(model)
    const queue = this.queues.get(key)

    // Try to hand off to a waiting entry (skip any settled entries from cancelWaiters)
    while (queue && queue.length > 0) {
      const next = queue.shift()
      if (!next) {
        continue
      }
      if (!next.settled) {
        // Hand off the slot to this waiter (count stays the same)
        next.resolve()
        return
      }
    }

    // No handoff occurred - decrement the count to free the slot
    const current = this.counts.get(key) ?? 0
    if (current > 0) {
      this.counts.set(key, current - 1)
    }
  }

  /**
   * Cancel a specific task's waiter in the queue for a model.
   * Returns true if a matching waiter was found and cancelled.
   */
  cancelWaiter(model: string, taskId: string): boolean {
    const key = this.getConcurrencyKey(model)
    const queue = this.queues.get(key)
    if (!queue) return false

    const index = queue.findIndex(entry => entry.taskId === taskId && !entry.settled)
    if (index === -1) return false

    const entry = queue[index]
    entry.settled = true
    if (entry.timeout) clearTimeout(entry.timeout)
    entry.rawReject(new Error(`Concurrency queue cancelled for task: ${taskId}`))
    queue.splice(index, 1)
    if (queue.length === 0) {
      this.queues.delete(key)
    }
    return true
  }

  /**
   * Cancel all waiting acquires for a model. Used during cleanup.
   */
  cancelWaiters(model: string): void {
    const key = this.getConcurrencyKey(model)
    const queue = this.queues.get(key)
    if (queue) {
      for (const entry of queue) {
        if (!entry.settled) {
          entry.settled = true
          if (entry.timeout) clearTimeout(entry.timeout)
          entry.rawReject(new Error(`Concurrency queue cancelled for model: ${model}`))
        }
      }
      this.queues.delete(key)
    }
  }

  /**
   * Clear all state. Used during manager cleanup/shutdown.
   * Cancels all pending waiters.
   */
  clear(): void {
    for (const [model] of this.queues) {
      this.cancelWaiters(model)
    }
    this.counts.clear()
    this.queues.clear()
  }

  /**
   * Get current count for a model (for testing/debugging)
   */
  getCount(model: string): number {
    return this.counts.get(model) ?? 0
  }

  /**
   * Get queue length for a model (for testing/debugging)
   */
  getQueueLength(model: string): number {
    return this.queues.get(model)?.length ?? 0
  }
}
