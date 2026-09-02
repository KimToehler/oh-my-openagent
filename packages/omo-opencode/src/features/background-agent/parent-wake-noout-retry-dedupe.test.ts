import { describe, expect, test } from "bun:test"
import { releaseAllPromptAsyncReservationsForTesting } from "../../hooks/shared/prompt-async-gate"
import {
  DEFAULT_PROMPT_ASYNC_POST_DISPATCH_HOLD_MS,
  DEFAULT_PROMPT_SEMANTIC_DEDUPE_HOLD_MS,
} from "@oh-my-opencode/utils/prompt-async-gate/timing"
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

const FINAL_WAKE = "<system-reminder>\n[BACKGROUND TASK COMPLETED]\n[ALL BACKGROUND TASKS COMPLETE]\n</system-reminder>"

function createNotifier(): {
  readonly notifier: ParentWakeNotifier
  readonly promptAsyncCalls: readonly PromptAsyncCall[]
} {
  const promptAsyncCalls: PromptAsyncCall[] = []
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
    },
  )
  return { notifier, promptAsyncCalls }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe("ParentWakeNotifier no-output retry vs semantic dedupe hold", () => {
  test(
    "#given a dispatched parent wake recorded in the semantic dedupe hold #when the no-output retry re-flushes the byte-identical wake while the hold is still active #then a real second dispatch reaches the client",
    async () => {
      // given
      const { notifier, promptAsyncCalls } = createNotifier()
      const sessionID = "parent-noout-retry-semantic-dedupe"
      notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "sisyphus" }, true)

      try {
        const firstDispatchAt = Date.now()
        await notifier.flushPendingParentWake(sessionID)
        expect(promptAsyncCalls).toHaveLength(1)
        expect(notifier.getDispatchedParentWakes().get(sessionID)?.notifications).toEqual([FINAL_WAKE])

        // when: the 1ms recovery window elapses without assistant output and the
        // SAME wake object is requeued for another dispatch
        await sleep(10)
        expect(notifier.getPendingParentWakes().get(sessionID)?.noAssistantOutputRetryCount).toBe(1)

        // The gate's post-dispatch reservation hold (2s) is real wall clock; wait
        // it out WITHOUT releasing anything so the retry reaches the semantic
        // dedupe check exactly as production does at roughly t+6s: past the
        // reservation, still deep inside the 15s semantic hold.
        await sleep(DEFAULT_PROMPT_ASYNC_POST_DISPATCH_HOLD_MS + 500)
        const retryElapsedMs = Date.now() - firstDispatchAt
        expect(retryElapsedMs).toBeGreaterThan(DEFAULT_PROMPT_ASYNC_POST_DISPATCH_HOLD_MS)
        expect(retryElapsedMs).toBeLessThan(DEFAULT_PROMPT_SEMANTIC_DEDUPE_HOLD_MS)
        await notifier.flushPendingParentWake(sessionID)

        // then: the retry must be a REAL second dispatch, not coalesced away by
        // the semantic hold the first send itself created
        expect(promptAsyncCalls).toHaveLength(2)
      } finally {
        notifier.shutdown()
        releaseAllPromptAsyncReservationsForTesting()
      }
    },
    15_000,
  )
})
