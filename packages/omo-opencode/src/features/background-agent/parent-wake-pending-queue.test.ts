import { afterEach, describe, expect, jest, test } from "bun:test"
import { releaseAllPromptAsyncReservationsForTesting } from "../../hooks/shared/prompt-async-gate"
import type { PendingParentWake } from "./parent-wake-dedupe"
import { ParentWakePendingQueue } from "./parent-wake-pending-queue"
import {
  COALESCE_REQUEUE_FLUSH_DELAY_MS,
  MAX_COALESCE_REQUEUE_ATTEMPTS,
  sendParentWakePrompt,
} from "./parent-wake-prompt-dispatch"

const DEFAULT_RETRY_MS = 1_000

function createQueue(): {
  readonly queue: ParentWakePendingQueue
  readonly flushes: string[]
} {
  const flushes: string[] = []
  return {
    flushes,
    queue: new ParentWakePendingQueue({
      pendingRetryMs: DEFAULT_RETRY_MS,
      enqueueNotificationForParent: async (_sessionID, operation) => {
        await operation()
      },
    }),
  }
}

async function drainAsyncTimerWork(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) {
    await Promise.resolve()
  }
}

describe("ParentWakePendingQueue scheduleFlush", () => {
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
    releaseAllPromptAsyncReservationsForTesting()
  })

  test("#given a default retry is armed #when a longer explicit delay is requested #then the flush moves to the later deadline", async () => {
    // given
    jest.useFakeTimers()
    const { queue, flushes } = createQueue()
    queue.scheduleFlush("parent", async () => {
      flushes.push("default")
    })

    // when
    queue.scheduleFlush("parent", async () => {
      flushes.push("coalesce")
    }, COALESCE_REQUEUE_FLUSH_DELAY_MS)
    jest.advanceTimersByTime(DEFAULT_RETRY_MS)
    await drainAsyncTimerWork()

    // then
    expect(flushes).toEqual([])
    expect(queue.getTimers().size).toBe(1)

    jest.advanceTimersByTime(COALESCE_REQUEUE_FLUSH_DELAY_MS - DEFAULT_RETRY_MS)
    await drainAsyncTimerWork()
    expect(flushes).toEqual(["coalesce"])
    expect(queue.getTimers().size).toBe(0)
  })

  test("#given no timer is armed #when a no-delay flush is scheduled #then it keeps the default retry cadence", async () => {
    // given
    jest.useFakeTimers()
    const { queue, flushes } = createQueue()

    // when
    queue.scheduleFlush("parent", async () => {
      flushes.push("default")
    })
    jest.advanceTimersByTime(DEFAULT_RETRY_MS - 1)
    await drainAsyncTimerWork()

    // then
    expect(flushes).toEqual([])
    jest.advanceTimersByTime(1)
    await drainAsyncTimerWork()
    expect(flushes).toEqual(["default"])
  })

  test("#given a later timer is armed #when a shorter explicit delay is requested #then the existing deadline is unchanged", async () => {
    // given
    jest.useFakeTimers()
    const { queue, flushes } = createQueue()
    queue.scheduleFlush("parent", async () => {
      flushes.push("later")
    }, COALESCE_REQUEUE_FLUSH_DELAY_MS)

    // when
    jest.advanceTimersByTime(500)
    queue.scheduleFlush("parent", async () => {
      flushes.push("shorter")
    }, DEFAULT_RETRY_MS)
    jest.advanceTimersByTime(COALESCE_REQUEUE_FLUSH_DELAY_MS - 501)
    await drainAsyncTimerWork()

    // then
    expect(flushes).toEqual([])
    jest.advanceTimersByTime(1)
    await drainAsyncTimerWork()
    expect(flushes).toEqual(["later"])
  })

  test("#given repeated longer-delay requests #when the first later deadline arrives #then the flush is not starved and only one timer fires", async () => {
    // given
    jest.useFakeTimers()
    const { queue, flushes } = createQueue()
    queue.scheduleFlush("parent", async () => {
      flushes.push("default")
    })
    queue.scheduleFlush("parent", async () => {
      flushes.push("first-long")
    }, COALESCE_REQUEUE_FLUSH_DELAY_MS)

    // when
    for (let request = 0; request < 3; request++) {
      jest.advanceTimersByTime(500)
      queue.scheduleFlush("parent", async () => {
        flushes.push("repeated-long")
      }, COALESCE_REQUEUE_FLUSH_DELAY_MS)
    }
    jest.advanceTimersByTime(COALESCE_REQUEUE_FLUSH_DELAY_MS - 1_500)
    await drainAsyncTimerWork()

    // then
    expect(flushes).toEqual(["first-long"])
    expect(queue.getTimers().size).toBe(0)
    jest.runOnlyPendingTimers()
    await drainAsyncTimerWork()
    expect(flushes).toEqual(["first-long"])
  })

  test("#given an existing default timer and an already-delivered wake #when real queue cadence drives coalesce retries #then the wake reaches a second real dispatch before the cap", async () => {
    // given
    jest.useFakeTimers()
    jest.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
    const { queue } = createQueue()
    const promptAsyncCalls: unknown[] = []
    const requeues: PendingParentWake[] = []
    const latestWake: PendingParentWake = {
      promptContext: { agent: "sisyphus" },
      notifications: ["wake A"],
      shouldReply: true,
      queuedAt: Date.now(),
    }
    const client = {
      session: {
        status: async () => ({ data: {} }),
        messages: async () => ({ data: [] }),
        promptAsync: async (call: unknown) => {
          promptAsyncCalls.push(call)
          return { data: {} }
        },
      },
    }
    const dispatch = async (): Promise<void> => {
      await sendParentWakePrompt({
        client,
        directory: "/tmp/test-omo",
        sessionID: "parent",
        latestWake,
        skipPromptGateStatusCheck: true,
        emptyAssistantTurnRetry: false,
        toolWaitDecision: { defer: false, skipPromptGateToolStateCheck: true },
        getDispatchedWake: () => undefined,
        hasRecordedPromptAfterDispatch: async () => false,
        trackDispatchedWake: () => {},
        requeueWake: (wake) => {
          requeues.push(wake)
        },
        scheduleFlush: (delayMs) => {
          queue.scheduleFlush("parent", dispatch, delayMs)
        },
      })
    }
    await dispatch()
    jest.advanceTimersByTime(2_001)
    queue.scheduleFlush("parent", dispatch)
    await dispatch()

    // when
    for (let attempt = 0; attempt < MAX_COALESCE_REQUEUE_ATTEMPTS; attempt++) {
      jest.advanceTimersByTime(COALESCE_REQUEUE_FLUSH_DELAY_MS)
      await drainAsyncTimerWork()
    }

    // then
    expect(promptAsyncCalls).toHaveLength(2)
    expect(requeues).toHaveLength(MAX_COALESCE_REQUEUE_ATTEMPTS)
    expect(queue.getTimers().size).toBe(0)
  })
})
