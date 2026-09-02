import { afterEach, describe, expect, test } from "bun:test"
import { releaseAllPromptAsyncReservationsForTesting } from "../../hooks/shared/prompt-async-gate"
import { DEFAULT_PROMPT_SEMANTIC_DEDUPE_HOLD_MS } from "@oh-my-opencode/utils/prompt-async-gate/timing"
import type { PendingParentWake } from "./parent-wake-dedupe"
import {
  COALESCE_REQUEUE_FLUSH_DELAY_MS,
  isDiscardedCoalesceDispatchResult,
  MAX_COALESCE_REQUEUE_ATTEMPTS,
  sendParentWakePrompt,
} from "./parent-wake-prompt-dispatch"

// The gate's post-dispatch reservation hold is 2s and its semantic dedupe hold
// is 15s. Advancing past the former while staying inside the latter is exactly
// the window where a retry coalesces as already-delivered instead of reserved.
const PAST_RESERVATION_HOLD_MS = 2_001

type DispatchFixture = {
  readonly promptAsyncCalls: unknown[]
  readonly trackedWakes: PendingParentWake[]
  readonly requeuedWakes: PendingParentWake[]
  readonly flushDelays: (number | undefined)[]
  readonly latestWake: PendingParentWake
  readonly advanceClock: (deltaMs: number) => void
  readonly restoreClock: () => void
  readonly send: (options?: {
    readonly forceNoReply?: boolean
    readonly retainPendingWake?: boolean
  }) => Promise<void>
}

function createDispatchFixture(sessionID: string): DispatchFixture {
  const promptAsyncCalls: unknown[] = []
  const trackedWakes: PendingParentWake[] = []
  const requeuedWakes: PendingParentWake[] = []
  const flushDelays: (number | undefined)[] = []
  const originalDateNow = Date.now
  let currentNow = originalDateNow()
  Date.now = () => currentNow
  const client = {
    session: {
      status: async () => ({ data: {} }),
      messages: async () => ({
        data: [{ info: { role: "assistant", finish: "stop", time: { created: currentNow - 10_000 } } }],
      }),
      promptAsync: async (call: unknown) => {
        promptAsyncCalls.push(call)
        return { data: {} }
      },
    },
  }
  const latestWake: PendingParentWake = {
    promptContext: { agent: "sisyphus" },
    notifications: ["wake A"],
    shouldReply: true,
    queuedAt: currentNow,
  }

  return {
    promptAsyncCalls,
    trackedWakes,
    requeuedWakes,
    flushDelays,
    latestWake,
    advanceClock: (deltaMs) => {
      currentNow += deltaMs
    },
    restoreClock: () => {
      Date.now = originalDateNow
    },
    send: async (options) =>
      sendParentWakePrompt({
        client,
        directory: "/tmp/test-omo",
        sessionID,
        latestWake,
        ...(options?.forceNoReply !== undefined ? { forceNoReply: options.forceNoReply } : {}),
        ...(options?.retainPendingWake !== undefined ? { retainPendingWake: options.retainPendingWake } : {}),
        skipPromptGateStatusCheck: true,
        emptyAssistantTurnRetry: false,
        toolWaitDecision: { defer: false, skipPromptGateToolStateCheck: true },
        getDispatchedWake: () => undefined,
        hasRecordedPromptAfterDispatch: async () => false,
        trackDispatchedWake: (wake) => {
          trackedWakes.push(wake)
        },
        requeueWake: (wake) => {
          requeuedWakes.push(wake)
        },
        scheduleFlush: (delayMs) => {
          flushDelays.push(delayMs)
        },
      }),
  }
}

describe("sendParentWakePrompt coalesce requeue", () => {
  afterEach(() => {
    releaseAllPromptAsyncReservationsForTesting()
  })

  test("#given a reply wake whose dispatch coalesces as already-delivered #when the flush runs #then the wake is requeued without being tracked as dispatched", async () => {
    // given: a first dispatch lands and records a recent semantic dispatch.
    const sessionID = "parent-coalesce-requeue-reply"
    const fixture = createDispatchFixture(sessionID)
    try {
      await fixture.send()
      expect(fixture.promptAsyncCalls).toHaveLength(1)
      expect(fixture.trackedWakes).toHaveLength(1)

      // when: an identical reply wake retries after the reservation hold but
      // inside the semantic dedupe hold, so the gate discards it.
      fixture.advanceClock(PAST_RESERVATION_HOLD_MS)
      await fixture.send()

      // then: the discarded wake is requeued instead of recorded as sent.
      expect(fixture.promptAsyncCalls).toHaveLength(1)
      expect(fixture.trackedWakes).toHaveLength(1)
      expect(fixture.requeuedWakes).toHaveLength(1)
      expect(fixture.flushDelays).toEqual([COALESCE_REQUEUE_FLUSH_DELAY_MS])
      // then: no retained-admission markers were written for the discarded wake.
      expect(fixture.latestWake.noReplyAdmittedAt).toBeUndefined()
      expect(fixture.latestWake.lastAdmitOnlyDepositAt).toBeUndefined()
      expect(fixture.latestWake.coalesceRequeueCount).toBe(1)
    } finally {
      fixture.restoreClock()
    }
  })

  test("#given an admit-only wake whose dispatch coalesces as already-delivered #when the flush runs #then it keeps the retained admission and never requeues", async () => {
    // given: a first admit-only deposit lands and records a recent semantic dispatch.
    const sessionID = "parent-coalesce-requeue-admit-only"
    const fixture = createDispatchFixture(sessionID)
    try {
      await fixture.send({ forceNoReply: true, retainPendingWake: true })
      expect(fixture.promptAsyncCalls).toHaveLength(1)
      expect(fixture.trackedWakes).toHaveLength(1)

      // when: an identical admit-only deposit coalesces within the semantic hold.
      fixture.advanceClock(PAST_RESERVATION_HOLD_MS)
      await fixture.send({ forceNoReply: true, retainPendingWake: true })

      // then: the gate discarded the duplicate deposit without re-dispatching...
      expect(fixture.promptAsyncCalls).toHaveLength(1)
      // ...and the admit-only path never requeues on coalesce; the retained
      // admission markers still land (issues #4874/#5086).
      expect(fixture.requeuedWakes).toHaveLength(0)
      expect(fixture.trackedWakes).toHaveLength(2)
      expect(fixture.latestWake.lastAdmitOnlyDepositAt).toBeDefined()
      expect(fixture.latestWake.coalesceRequeueCount).toBeUndefined()
    } finally {
      fixture.restoreClock()
    }
  })

  test("#given a wake that keeps coalescing as already-delivered #when the flush retries #then requeues terminate at exactly the dedicated cap", async () => {
    // given: a first dispatch lands and holds the semantic dedupe record.
    const sessionID = "parent-coalesce-requeue-cap"
    const fixture = createDispatchFixture(sessionID)
    try {
      await fixture.send()
      expect(fixture.promptAsyncCalls).toHaveLength(1)

      // when: every retry keeps coalescing until the cap is exhausted, plus one
      // more attempt beyond it.
      for (let attempt = 0; attempt < MAX_COALESCE_REQUEUE_ATTEMPTS + 1; attempt++) {
        fixture.advanceClock(PAST_RESERVATION_HOLD_MS)
        await fixture.send()
      }

      // then: exactly MAX_COALESCE_REQUEUE_ATTEMPTS requeues happened, and the
      // attempt beyond the cap was recorded as dispatched so the loop terminates
      // and closes that coalesce episode.
      expect(MAX_COALESCE_REQUEUE_ATTEMPTS).toBe(3)
      expect(fixture.requeuedWakes).toHaveLength(3)
      expect(fixture.latestWake.coalesceRequeueCount).toBeUndefined()
      expect(fixture.flushDelays).toEqual([
        COALESCE_REQUEUE_FLUSH_DELAY_MS,
        COALESCE_REQUEUE_FLUSH_DELAY_MS,
        COALESCE_REQUEUE_FLUSH_DELAY_MS,
      ])
      expect(fixture.trackedWakes).toHaveLength(2)
      expect(fixture.promptAsyncCalls).toHaveLength(1)
    } finally {
      fixture.restoreClock()
    }
  })

  test("#given the requeue budget and the semantic dedupe hold #when comparing them #then the budget always outlasts the hold", () => {
    // given / when / then: the invariant itself, not the resulting numbers. If
    // a future edit to timing.ts or to either constant shrinks the budget back
    // under the hold, every requeue coalesces, the cap exhausts inside the
    // hold, and the wake is silently recorded as dispatched without ever
    // reaching the client. This assertion makes that edit fail loudly.
    expect(MAX_COALESCE_REQUEUE_ATTEMPTS * COALESCE_REQUEUE_FLUSH_DELAY_MS).toBeGreaterThanOrEqual(
      DEFAULT_PROMPT_SEMANTIC_DEDUPE_HOLD_MS,
    )
  })

  test("#given a wake that keeps coalescing #when retries fire on the real flush schedule #then the semantic hold expires before the budget and the wake dispatches for real", async () => {
    // given: a first dispatch lands and records a recent semantic dispatch.
    const sessionID = "parent-coalesce-requeue-survival"
    const fixture = createDispatchFixture(sessionID)
    try {
      await fixture.send()
      expect(fixture.promptAsyncCalls).toHaveLength(1)

      // when: each retry waits the actual scheduled flush delay before firing,
      // exactly as production timers would.
      for (let attempt = 0; attempt < MAX_COALESCE_REQUEUE_ATTEMPTS; attempt++) {
        fixture.advanceClock(COALESCE_REQUEUE_FLUSH_DELAY_MS)
        await fixture.send()
      }

      // then: the semantic hold expired inside the budget, so a later retry
      // reached the client for real instead of exhausting the cap and being
      // silently recorded as dispatched.
      expect(fixture.promptAsyncCalls).toHaveLength(2)
      expect(fixture.trackedWakes).toHaveLength(2)
      expect(fixture.requeuedWakes).toHaveLength(2)
      expect(fixture.latestWake.coalesceRequeueCount).toBeUndefined()
    } finally {
      fixture.restoreClock()
    }
  })

  test("#given a wake that coalesced once and then dispatched successfully #when a new same-notification episode starts #then the full coalesce requeue budget is restored", async () => {
    // given: one discarded coalesce consumes one attempt from the current episode.
    const sessionID = "parent-coalesce-requeue-new-episode"
    const fixture = createDispatchFixture(sessionID)
    try {
      await fixture.send()
      fixture.advanceClock(PAST_RESERVATION_HOLD_MS)
      await fixture.send()
      expect(fixture.latestWake.coalesceRequeueCount).toBe(1)

      // when: semantic dedupe expires and the same wake reaches the client in a
      // successful dispatch, ending the current coalesce episode.
      fixture.advanceClock(DEFAULT_PROMPT_SEMANTIC_DEDUPE_HOLD_MS)
      await fixture.send()

      // then: a later no-output retry with unchanged notifications starts with
      // the full budget instead of inheriting the prior episode's count.
      expect(fixture.promptAsyncCalls).toHaveLength(2)
      expect(fixture.latestWake.coalesceRequeueCount).toBeUndefined()
    } finally {
      fixture.restoreClock()
    }
  })

  test("#given the coalesce discriminator #when classifying dispatch results #then only already-delivered counts as discarded", () => {
    // given / when / then: the named coalesceKind field is the discriminator,
    // so an in-flight coalesce and a plain queued result stay on the
    // tracked-as-dispatched path.
    expect(isDiscardedCoalesceDispatchResult({
      status: "queued",
      queuedBy: "background-agent-parent-wake",
      position: 0,
      coalesceKind: "already-delivered",
    })).toBe(true)
    expect(isDiscardedCoalesceDispatchResult({
      status: "queued",
      queuedBy: "background-agent-parent-wake",
      position: 0,
      coalesceKind: "in-flight",
    })).toBe(false)
    expect(isDiscardedCoalesceDispatchResult({
      status: "queued",
      queuedBy: "background-agent-parent-wake",
      position: 1,
    })).toBe(false)
    expect(isDiscardedCoalesceDispatchResult({ status: "dispatched", response: {} })).toBe(false)
  })
})
