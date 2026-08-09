import { describe, expect, test } from "bun:test"
import { releaseAllPromptAsyncReservationsForTesting } from "../../hooks/shared/prompt-async-gate"
import { ParentWakeNotifier } from "./parent-wake-notifier"

type ParentWakeNotifierClientForTest = ConstructorParameters<typeof ParentWakeNotifier>[0]["client"]
type PromptAsyncCall = Parameters<ParentWakeNotifierClientForTest["session"]["promptAsync"]>[0]

type SessionMessageStub = {
  readonly info?: {
    readonly role?: string
    readonly finish?: string
    readonly time?: { readonly created?: number }
  }
  readonly parts?: readonly { readonly type?: string; readonly text?: string }[]
}

const PROGRESS_WAKE = "<system-reminder>\n[BACKGROUND TASK PROGRESS]\n</system-reminder>"

function createNotifier(options: { readonly activityWindowMs?: number } = {}): {
  readonly notifier: ParentWakeNotifier
  readonly promptAsyncCalls: readonly PromptAsyncCall[]
} {
  const promptAsyncCalls: PromptAsyncCall[] = []
  // A settled assistant turn from well before the wake: nothing here can ever be
  // mistaken for output produced BY the wake, which is the whole point - a
  // noReply deposit never forks an assistant turn, so no later output exists.
  const sessionMessages: readonly SessionMessageStub[] = [
    {
      info: {
        role: "assistant",
        finish: "stop",
        time: { created: Date.now() - 10_000 },
      },
    },
  ]
  const client: ParentWakeNotifierClientForTest = {
    session: {
      messages: async () => ({ data: sessionMessages }),
      status: async () => ({ data: {} }),
      promptAsync: async (call: PromptAsyncCall) => {
        promptAsyncCalls.push(call)
        return { data: {} }
      },
    },
  }
  const notifier = new ParentWakeNotifier(
    {
      client,
      directory: "/tmp/test-omo",
      enqueueNotificationForParent: async (_sessionID, operation) => {
        await operation()
      },
    },
    {
      pendingRetryMs: 1_000,
      acceptedMessageSkewMs: 100,
      toolCallDeferMaxMs: 5_000,
      failureRequeueWindowMs: 1,
      userMessageInProgressWindowMs: 0,
      ...(options.activityWindowMs !== undefined
        ? { parentSessionActivityInProgressWindowMs: options.activityWindowMs }
        : {}),
    },
  )
  return { notifier, promptAsyncCalls }
}

async function waitForTimer(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 10)
  })
}

describe("ParentWakeNotifier noReply deposit window recovery", () => {
  test("#given a noReply parent wake was deposited #when the recovery window elapses with no assistant output #then it is not retried as a failed dispatch", async () => {
    // given
    const { notifier, promptAsyncCalls } = createNotifier()
    const sessionID = "parent-noreply-window-no-retry"
    notifier.queuePendingParentWake(sessionID, PROGRESS_WAKE, { agent: "sisyphus" }, false)

    try {
      await notifier.flushPendingParentWake(sessionID)
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body?.noReply).toBe(true)

      // when
      await waitForTimer()

      // then
      expect(notifier.getPendingParentWakes().has(sessionID)).toBe(false)
      expect(notifier.getPendingParentWakeTimers().has(sessionID)).toBe(false)
      expect(notifier.getDispatchedParentWakes().has(sessionID)).toBe(false)
    } finally {
      notifier.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  test("#given an admit-only deposit landed because parent activity was fresh #when the recovery window elapses #then the notification is not deposited a second time", async () => {
    // given
    const { notifier, promptAsyncCalls } = createNotifier({ activityWindowMs: 5_000 })
    const sessionID = "parent-admit-only-window-no-duplicate"
    notifier.recordParentSessionActivity(sessionID)
    notifier.queuePendingParentWake(sessionID, PROGRESS_WAKE, { agent: "sisyphus" }, false)

    try {
      await notifier.flushPendingParentWake(sessionID)
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body?.noReply).toBe(true)

      // when
      await waitForTimer()

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      expect(notifier.getPendingParentWakes().has(sessionID)).toBe(false)
    } finally {
      notifier.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })
})
