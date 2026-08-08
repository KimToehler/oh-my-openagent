import { afterEach, describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { ParentWakeNotifier } from "./parent-wake-notifier"
import { MAX_COALESCE_REQUEUE_ATTEMPTS } from "./parent-wake-prompt-dispatch"
import {
  releaseAllPromptAsyncReservationsForTesting,
  releasePromptAsyncReservation,
} from "../../hooks/shared/prompt-async-gate"

type PromptAsyncCall = {
  path: { id: string }
  body: {
    noReply?: boolean
    parts?: unknown[]
  }
  query?: {
    directory: string
  }
}

type SessionMessageStub = {
  info?: {
    role?: string
    finish?: string
    time?: { created?: number; completed?: number }
  }
  parts?: Array<{ type?: string; text?: string; synthetic?: boolean; state?: { status?: string } }>
}

const PROGRESS_WAKE = [
  "<system-reminder>",
  "[BACKGROUND TASK RESULT READY]",
  "**ID:** `task-a`",
  "**Description:** task A",
  "**Duration:** 10s",
  "",
  "**1 task still in progress.** You WILL be notified when ALL complete.",
  "Do NOT poll - continue productive work.",
  "",
  'Use `background_output(task_id="task-a")` to retrieve this result when ready.',
  "</system-reminder>",
].join("\n")

const FINAL_WAKE = [
  "<system-reminder>",
  "[BACKGROUND TASK COMPLETED]",
  "[ALL BACKGROUND TASKS COMPLETE]",
  "",
  "**Completed:**",
  "- `task-a`: task A",
  "",
  'Use `background_output(task_id="<id>")` to retrieve each result.',
  "</system-reminder>",
].join("\n")

const FINISHED_WITH_FAILURES_WAKE = [
  "<system-reminder>",
  "[ALL BACKGROUND TASKS FINISHED (1 FAILED)]",
  "",
  "**Failed:**",
  "- `task-a`: task A",
  "",
  'Use `background_output(task_id="<id>")` to retrieve each result.',
  "</system-reminder>",
].join("\n")

const BLOCKED_MESSAGES: SessionMessageStub[] = [
  {
    info: { role: "user", time: { created: 80_000 } },
    parts: [{ type: "text", text: "start work" }],
  },
  {
    info: { role: "assistant", finish: "tool-calls", time: { created: 99_500 } },
    parts: [{ type: "tool", state: { status: "running" } }],
  },
]

const SAFE_MESSAGES: SessionMessageStub[] = [
  {
    info: { role: "user", time: { created: 80_000 } },
    parts: [{ type: "text", text: "start work" }],
  },
  {
    info: { role: "assistant", finish: "stop", time: { created: 90_000 } },
    parts: [{ type: "text", text: "delegated to background" }],
  },
]

function createNotifier(args: {
  sessionStatuses: Record<string, { type: string }>
  messagesProvider: () => SessionMessageStub[]
  parentActivityWindowMs?: number
}): {
  notifier: ParentWakeNotifier
  promptAsyncCalls: PromptAsyncCall[]
} {
  const promptAsyncCalls: PromptAsyncCall[] = []
  const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:1" })
  Object.assign(client.session, {
    messages: async () => ({ data: args.messagesProvider() }),
    status: async () => ({ data: args.sessionStatuses }),
    promptAsync: async (call: PromptAsyncCall) => {
      promptAsyncCalls.push(call)
      return { data: {} }
    },
    abort: async () => ({ data: {} }),
  })

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
      acceptedMessageSkewMs: 5_000,
      toolCallDeferMaxMs: 5_000,
      failureRequeueWindowMs: 5_000,
      userMessageInProgressWindowMs: 2_000,
      parentSessionActivityInProgressWindowMs: args.parentActivityWindowMs,
    },
  )

  return { notifier, promptAsyncCalls }
}

function releaseParentWakeHold(sessionID: string): void {
  releasePromptAsyncReservation(sessionID, "test:simulate-expired-parent-wake-hold", {
    reservedBy: "background-agent-parent-wake",
  })
}

afterEach(() => {
  releaseAllPromptAsyncReservationsForTesting()
})

describe("parent wake mid-batch starvation characterization", () => {
  test("#given a mid-batch noReply wake ages past the ceiling while the parent stays busy with safe history #when the final allComplete wake merges into it #then a single reply is dispatched carrying the final text", async () => {
    // given
    const originalDateNow = Date.now
    let now = 100_000
    Date.now = () => now
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionStatuses: { "parent-1": { type: "busy" } },
      messagesProvider: () => SAFE_MESSAGES,
    })
    notifier.queuePendingParentWake("parent-1", PROGRESS_WAKE, { agent: "sisyphus" }, false)

    try {
      // when
      await notifier.flushPendingParentWake("parent-1")
      now = 160_000
      notifier.clearPendingParentWakeTimer("parent-1")
      await notifier.flushPendingParentWake("parent-1")
      now = 220_000
      notifier.clearPendingParentWakeTimer("parent-1")
      await notifier.flushPendingParentWake("parent-1")

      // then
      expect(promptAsyncCalls).toHaveLength(0)
      expect(notifier.getPendingParentWakes().get("parent-1")?.shouldReply).toBe(false)

      // when
      notifier.queuePendingParentWake("parent-1", FINAL_WAKE, { agent: "sisyphus" }, true)
      notifier.clearPendingParentWakeTimer("parent-1")
      await notifier.flushPendingParentWake("parent-1")

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).not.toBe(true)
      const dispatchedText = JSON.stringify(promptAsyncCalls[0]?.body.parts)
      expect(dispatchedText).toContain("[ALL BACKGROUND TASKS COMPLETE]")
      expect(dispatchedText).not.toContain("still in progress")
      expect(notifier.getPendingParentWakes().has("parent-1")).toBe(false)
    } finally {
      Date.now = originalDateNow
      notifier.shutdown()
    }
  })

  test("#given a mid-batch noReply wake admitted while history was unsafe #when the final wake merges and the parent remains persistently unsafe #then the wake is delivered within a bounded deadline", async () => {
    // given
    const originalDateNow = Date.now
    let now = 100_000
    Date.now = () => now
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionStatuses: { "parent-1": { type: "busy" } },
      messagesProvider: () => BLOCKED_MESSAGES,
    })
    notifier.queuePendingParentWake("parent-1", PROGRESS_WAKE, { agent: "sisyphus" }, false)

    try {
      // when
      await notifier.flushPendingParentWake("parent-1")

      // then
      expect(promptAsyncCalls).toHaveLength(0)
      expect(notifier.getPendingParentWakes().get("parent-1")?.shouldReply).toBe(false)

      // when
      now = 160_000
      notifier.queuePendingParentWake("parent-1", FINAL_WAKE, { agent: "sisyphus" }, true)
      notifier.clearPendingParentWakeTimer("parent-1")
      now = 220_000
      await notifier.flushPendingParentWake("parent-1")

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).toBe(true)
      expect(notifier.getPendingParentWakes().get("parent-1")?.noReplyAdmittedAt).toBeDefined()
      const callCountAfterAdmission = promptAsyncCalls.length

      // when
      releaseParentWakeHold("parent-1")
      notifier.clearPendingParentWakeTimer("parent-1")
      now = 400_000
      await notifier.flushPendingParentWake("parent-1")
      releaseParentWakeHold("parent-1")
      notifier.clearPendingParentWakeTimer("parent-1")
      now = 700_000
      await notifier.flushPendingParentWake("parent-1")

      // then
      // The wake must still be pending with shouldReply true: this proves any
      // failure below is an unbounded defer, NOT a dropped wake, a merge bug,
      // or a dedupe suppression.
      expect(notifier.getPendingParentWakes().get("parent-1")?.shouldReply).toBe(true)
      expect(notifier.getPendingParentWakeTimers().has("parent-1")).toBe(true)
      // Intended post-fix behavior: a bounded deadline forces at least one
      // further delivery (re-admission or reply) after the first unsafe
      // admission. Pre-fix, deferReplyWakeWhileUnsafe reschedules forever.
      expect(promptAsyncCalls.length).toBeGreaterThan(callCountAfterAdmission)
    } finally {
      Date.now = originalDateNow
      notifier.shutdown()
    }
  })

  test("#given an admitted wake consumed by the live turn #when the re-admission interval elapses #then the wake is dropped, not re-admitted", async () => {
    // given
    const originalDateNow = Date.now
    let now = 100_000
    Date.now = () => now
    let consumed = false
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionStatuses: { "parent-1": { type: "busy" } },
      messagesProvider: () =>
        consumed
          ? [
              ...BLOCKED_MESSAGES,
              {
                info: { role: "assistant", finish: "tool-calls", time: { created: 230_000 } },
                parts: [
                  { type: "text", text: "retrieving background results" },
                  { type: "tool", state: { status: "running" } },
                ],
              },
            ]
          : BLOCKED_MESSAGES,
    })
    notifier.queuePendingParentWake("parent-1", PROGRESS_WAKE, { agent: "sisyphus" }, false)
    notifier.queuePendingParentWake("parent-1", FINAL_WAKE, { agent: "sisyphus" }, true)
    const wake = notifier.getPendingParentWakes().get("parent-1")
    if (!wake) throw new Error("expected pending wake")
    wake.queuedAt = 40_000

    try {
      // when: the merged wake is admitted as noReply while history is unsafe
      await notifier.flushPendingParentWake("parent-1")

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).toBe(true)
      expect(notifier.getPendingParentWakes().get("parent-1")?.noReplyAdmittedAt).toBeDefined()

      // when: the live turn consumes the deposit and the re-admission interval elapses
      consumed = true
      releaseParentWakeHold("parent-1")
      notifier.clearPendingParentWakeTimer("parent-1")
      now = 700_000
      await notifier.flushPendingParentWake("parent-1")

      // then: dropAdmittedWakeConsumedByParent runs before any re-admission
      // consideration — the wake is dropped, never re-admitted or re-dispatched
      expect(promptAsyncCalls).toHaveLength(1)
      expect(notifier.getPendingParentWakes().has("parent-1")).toBe(false)
    } finally {
      Date.now = originalDateNow
      notifier.shutdown()
    }
  })

  test("#given an admit-only deposit fired for a noReply wake #when a reply-required wake merges and the live turn consumes the deposit #then the reply-required wake is still dispatched as a reply", async () => {
    // given
    const originalDateNow = Date.now
    let now = 100_000
    Date.now = () => now
    let consumed = false
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionStatuses: { "parent-1": { type: "busy" } },
      messagesProvider: () =>
        consumed
          ? [
              ...SAFE_MESSAGES,
              {
                info: { role: "assistant", finish: "stop", time: { created: 470_000 } },
                parts: [{ type: "text", text: "kept working through the deposit" }],
              },
            ]
          : SAFE_MESSAGES,
    })
    notifier.queuePendingParentWake("parent-1", PROGRESS_WAKE, { agent: "sisyphus" }, false)

    try {
      // when: the admit-only deposit ceiling elapses for the noReply wake
      now = 460_000
      notifier.clearPendingParentWakeTimer("parent-1")
      await notifier.flushPendingParentWake("parent-1")

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).toBe(true)

      // when: a reply-required wake with the same notification merges in, the
      // live turn consumes the deposit, and the parent history becomes safe
      notifier.queuePendingParentWake("parent-1", PROGRESS_WAKE, { agent: "sisyphus" }, true)
      expect(notifier.getPendingParentWakes().get("parent-1")?.shouldReply).toBe(true)
      consumed = true
      releaseParentWakeHold("parent-1")
      notifier.clearPendingParentWakeTimer("parent-1")
      now = 530_000
      await notifier.flushPendingParentWake("parent-1")

      // then: the reply-required wake is dispatched as a reply, never dropped
      // on an admission timestamp earned by the admit-only deposit
      expect(promptAsyncCalls).toHaveLength(2)
      expect(promptAsyncCalls[1]?.body.noReply).not.toBe(true)
      expect(JSON.stringify(promptAsyncCalls[1]?.body.parts)).toContain("[BACKGROUND TASK RESULT READY]")
    } finally {
      Date.now = originalDateNow
      notifier.shutdown()
    }
  })

  test("#given a failure-classified final wake parked in the tool-wait deferral while the parent stays unsafe #when the retained-admit ceiling elapses #then a bounded noReply deposit is delivered", async () => {
    // given
    const originalDateNow = Date.now
    let now = 100_000
    Date.now = () => now
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionStatuses: { "parent-1": { type: "idle" } },
      messagesProvider: () => BLOCKED_MESSAGES,
    })
    notifier.queuePendingParentWake("parent-1", FINISHED_WITH_FAILURES_WAKE, { agent: "sisyphus" }, true)

    try {
      // when: flush while the latest assistant turn blocks internal prompts
      await notifier.flushPendingParentWake("parent-1")
      now = 200_000
      notifier.clearPendingParentWakeTimer("parent-1")
      await notifier.flushPendingParentWake("parent-1")

      // then: within the ceiling the failure wake stays parked without admission
      expect(promptAsyncCalls).toHaveLength(0)
      // The wake must still be pending with shouldReply true: this proves any
      // failure below is an unbounded defer, NOT a dropped wake.
      expect(notifier.getPendingParentWakes().get("parent-1")?.shouldReply).toBe(true)
      expect(notifier.getPendingParentWakeTimers().has("parent-1")).toBe(true)

      // when: the retained-admit ceiling elapses while the parent stays unsafe
      now = 500_000
      notifier.clearPendingParentWakeTimer("parent-1")
      await notifier.flushPendingParentWake("parent-1")

      // then: a bounded noReply deposit is delivered, the reply stays owed
      expect(promptAsyncCalls.length).toBeGreaterThan(0)
      expect(promptAsyncCalls[0]?.body.noReply).toBe(true)
      expect(notifier.getPendingParentWakes().get("parent-1")?.shouldReply).toBe(true)
    } finally {
      Date.now = originalDateNow
      notifier.shutdown()
    }
  })

  test("#given a ceiling deposit refreshes the parent activity window #when subsequent flushes run #then no tight re-deposit loop forms and the next deposit waits a full ceiling", async () => {
    // given
    const originalDateNow = Date.now
    let now = 100_000
    Date.now = () => now
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionStatuses: { "parent-1": { type: "idle" } },
      messagesProvider: () => BLOCKED_MESSAGES,
      parentActivityWindowMs: 5_500,
    })
    notifier.queuePendingParentWake("parent-1", FINISHED_WITH_FAILURES_WAKE, { agent: "sisyphus" }, true)

    try {
      // when: the ceiling elapses and the first deposit fires
      now = 500_000
      await notifier.flushPendingParentWake("parent-1")

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).toBe(true)

      // when: the deposit's own prompt refreshes the parent activity window
      notifier.recordParentSessionActivity("parent-1")
      releaseParentWakeHold("parent-1")
      notifier.clearPendingParentWakeTimer("parent-1")
      now = 503_000
      await notifier.flushPendingParentWake("parent-1")

      // then: the fresh-activity defer does not immediately re-deposit
      expect(promptAsyncCalls).toHaveLength(1)

      // when: the activity window lapses but the ceiling has not elapsed again
      now = 560_000
      notifier.clearPendingParentWakeTimer("parent-1")
      await notifier.flushPendingParentWake("parent-1")
      now = 680_000
      notifier.clearPendingParentWakeTimer("parent-1")
      await notifier.flushPendingParentWake("parent-1")

      // then: no deposit at +60s or +180s after the first
      expect(promptAsyncCalls).toHaveLength(1)
      expect(notifier.getPendingParentWakes().get("parent-1")?.shouldReply).toBe(true)

      // when: a full ceiling elapses since the first deposit
      now = 805_000
      notifier.clearPendingParentWakeTimer("parent-1")
      await notifier.flushPendingParentWake("parent-1")

      // then: exactly one further bounded deposit
      expect(promptAsyncCalls).toHaveLength(2)
      expect(promptAsyncCalls[1]?.body.noReply).toBe(true)
      expect(notifier.getPendingParentWakes().get("parent-1")?.shouldReply).toBe(true)
    } finally {
      Date.now = originalDateNow
      notifier.shutdown()
    }
  })

  test("#given a mid-batch noReply wake with no final wake ever arriving #when the parent stays busy indefinitely #then the wake is delivered within a bounded deadline", async () => {
    // given
    const originalDateNow = Date.now
    let now = 100_000
    Date.now = () => now
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionStatuses: { "parent-1": { type: "busy" } },
      messagesProvider: () => SAFE_MESSAGES,
    })
    notifier.queuePendingParentWake("parent-1", PROGRESS_WAKE, { agent: "sisyphus" }, false)

    try {
      // when
      now = 130_000
      notifier.clearPendingParentWakeTimer("parent-1")
      await notifier.flushPendingParentWake("parent-1")

      // then
      // Asserted well before any plausible delivery ceiling: the wake exists at
      // the notifier layer (the manager queues one per completed sibling), so a
      // starvation below lives in wake delivery, not in wake creation.
      expect(notifier.getPendingParentWakes().get("parent-1")?.shouldReply).toBe(false)
      expect(notifier.getPendingParentWakeTimers().has("parent-1")).toBe(true)

      // when
      now = 220_000
      notifier.clearPendingParentWakeTimer("parent-1")
      await notifier.flushPendingParentWake("parent-1")
      now = 400_000
      notifier.clearPendingParentWakeTimer("parent-1")
      await notifier.flushPendingParentWake("parent-1")
      now = 700_000
      notifier.clearPendingParentWakeTimer("parent-1")
      await notifier.flushPendingParentWake("parent-1")

      // then
      // The wake must still be pending: this proves any failure below is an
      // unbounded defer at the delivery layer, not a dropped or missing wake.
      expect(notifier.getPendingParentWakes().get("parent-1")?.shouldReply).toBe(false)
      expect(notifier.getPendingParentWakeTimers().has("parent-1")).toBe(true)
      // Intended post-fix behavior: the deposit reaches the parent within a
      // bounded deadline even when no final wake ever arrives. Pre-fix, a
      // shouldReply:false wake on a busy parent is deferred forever before any
      // admission — not even a noReply deposit is made.
      expect(promptAsyncCalls.length).toBeGreaterThan(0)
    } finally {
      Date.now = originalDateNow
      notifier.shutdown()
    }
  })

  test("#given a reply wake retry the gate discards as an already-delivered coalesce #when the discarded dispatch returns #then neither admission marker is written, while a genuine retained admission still writes both", async () => {
    // given: an idle parent with safe history, so the first flush takes the
    // plain reply path and records a semantic dedupe entry for that prompt.
    const originalDateNow = Date.now
    let now = 100_000
    Date.now = () => now
    let historyBlocked = false
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionStatuses: { "parent-1": { type: "idle" } },
      messagesProvider: () => (historyBlocked ? BLOCKED_MESSAGES : SAFE_MESSAGES),
    })
    notifier.queuePendingParentWake("parent-1", FINAL_WAKE, { agent: "sisyphus" }, true)

    try {
      // when
      await notifier.flushPendingParentWake("parent-1")

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).not.toBe(true)

      // when: the same wake is requeued and retried past the gate's 2s
      // post-dispatch hold but inside its 15s semantic dedupe hold, so the gate
      // discards the retry as already-delivered.
      expect(await notifier.requeueDispatchedParentWake("parent-1", "test:simulate-late-prompt-failure")).toBe(true)
      now = 103_000
      notifier.clearPendingParentWakeTimer("parent-1")
      await notifier.flushPendingParentWake("parent-1")

      // then: the retry never reached the client, so it is a phantom delivery
      // and must leave no delivery footprint. Neither marker guarding issues
      // #4874/#5086 may be written, and the wake must not be recorded as sent.
      expect(promptAsyncCalls).toHaveLength(1)
      const coalescedWake = notifier.getPendingParentWakes().get("parent-1")
      expect(coalescedWake?.noReplyAdmittedAt).toBeUndefined()
      expect(coalescedWake?.lastAdmitOnlyDepositAt).toBeUndefined()
      expect(coalescedWake?.coalesceRequeueCount).toBe(1)
      expect(notifier.getDispatchedParentWakes().has("parent-1")).toBe(false)

      // when: the semantic hold lapses and the parent history turns unsafe, so
      // the next flush is a GENUINE retained admit-only dispatch.
      historyBlocked = true
      now = 120_000
      notifier.clearPendingParentWakeTimer("parent-1")
      await notifier.flushPendingParentWake("parent-1")

      // then: control for the assertions above. The marker-writing code is live
      // and reachable, so "unset after a coalesce" is a real observation rather
      // than a vacuously passing assertion.
      expect(promptAsyncCalls).toHaveLength(2)
      expect(promptAsyncCalls[1]?.body.noReply).toBe(true)
      const admittedWake = notifier.getPendingParentWakes().get("parent-1")
      expect(admittedWake?.noReplyAdmittedAt).toBe(120_000)
      expect(admittedWake?.lastAdmitOnlyDepositAt).toBe(120_000)
    } finally {
      Date.now = originalDateNow
      notifier.shutdown()
    }
  })

  test("#given a wake carrying one genuine no-output retry #when coalesce requeue cycles run to the cap #then the no-output retry budget is untouched and only the coalesce counter moves", async () => {
    // given: a wake seeded with the single retry that parent-wake-window-recovery
    // records after a real no-output dispatch. That path is the ONLY legitimate
    // increment of noAssistantOutputRetryCount.
    const originalDateNow = Date.now
    let now = 100_000
    Date.now = () => now
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionStatuses: { "parent-1": { type: "idle" } },
      messagesProvider: () => SAFE_MESSAGES,
    })
    notifier.queuePendingParentWake("parent-1", FINAL_WAKE, { agent: "sisyphus" }, true)
    const seededWake = notifier.getPendingParentWakes().get("parent-1")
    if (!seededWake) throw new Error("expected pending wake")
    seededWake.noAssistantOutputRetryCount = 1

    try {
      // when: the seeded wake dispatches once and is requeued for retry
      await notifier.flushPendingParentWake("parent-1")
      expect(promptAsyncCalls).toHaveLength(1)
      expect(await notifier.requeueDispatchedParentWake("parent-1", "test:simulate-late-prompt-failure")).toBe(true)
      expect(notifier.getPendingParentWakes().get("parent-1")?.noAssistantOutputRetryCount).toBe(1)

      // when: every retry inside the semantic hold coalesces as already-delivered
      const observedRetryBudgets: (number | undefined)[] = []
      const observedCoalesceCounts: (number | undefined)[] = []
      for (let cycle = 1; cycle <= MAX_COALESCE_REQUEUE_ATTEMPTS; cycle++) {
        now = 100_000 + cycle * 3_000
        notifier.clearPendingParentWakeTimer("parent-1")
        await notifier.flushPendingParentWake("parent-1")
        const cycleWake = notifier.getPendingParentWakes().get("parent-1")
        observedRetryBudgets.push(cycleWake?.noAssistantOutputRetryCount)
        observedCoalesceCounts.push(cycleWake?.coalesceRequeueCount)
      }

      // then: the two counters have separate lifecycles. Coalesce requeues move
      // coalesceRequeueCount only; the no-output retry budget is neither
      // incremented nor decremented, and no cycle reached the client.
      expect(observedCoalesceCounts).toEqual([1, 2, 3])
      expect(observedRetryBudgets).toEqual([1, 1, 1])
      expect(promptAsyncCalls).toHaveLength(1)

      // when: one more retry runs past the cap, so the wake is recorded as sent
      now = 100_000 + (MAX_COALESCE_REQUEUE_ATTEMPTS + 1) * 3_000
      notifier.clearPendingParentWakeTimer("parent-1")
      await notifier.flushPendingParentWake("parent-1")

      // then: the budget still reads exactly the one genuine no-output retry
      expect(promptAsyncCalls).toHaveLength(1)
      const trackedWake = notifier.getDispatchedParentWakes().get("parent-1")
      expect(trackedWake?.coalesceRequeueCount).toBe(MAX_COALESCE_REQUEUE_ATTEMPTS)
      expect(trackedWake?.noAssistantOutputRetryCount).toBe(1)
    } finally {
      Date.now = originalDateNow
      notifier.shutdown()
    }
  })
})
