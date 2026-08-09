/// <reference path="../../../bun-test.d.ts" />
import { afterEach, describe, expect, test } from "bun:test"

import {
  dispatchInternalPrompt,
  releaseAllPromptAsyncReservationsForTesting,
} from "./prompt-async-gate"

describe("dispatchInternalPrompt coalesceKind discriminator", () => {
  afterEach(() => {
    // then
    releaseAllPromptAsyncReservationsForTesting()
  })

  test("#given an identical prompt already dispatched within the semantic hold #when the duplicate arrives #then the coalesced result names coalesceKind already-delivered", async () => {
    // given
    const promptCalls: string[] = []
    const originalDateNow = Date.now
    let currentNow = originalDateNow()
    Date.now = () => currentNow
    const input = {
      path: { id: "ses_coalesce_kind_delivered" },
      body: { parts: [{ type: "text", text: "wake" }] },
    }
    const client = {
      session: {
        promptAsync: async () => {
          promptCalls.push("prompt")
        },
      },
    }

    try {
      // when
      const first = await dispatchInternalPrompt({
        mode: "async",
        client,
        sessionID: "ses_coalesce_kind_delivered",
        input,
        source: "test:coalesce-kind:delivered:first",
        settleMs: 0,
        postDispatchHoldMs: 1,
      })
      currentNow += 2
      const second = await dispatchInternalPrompt({
        mode: "async",
        client,
        sessionID: "ses_coalesce_kind_delivered",
        input,
        source: "test:coalesce-kind:delivered:second",
        settleMs: 0,
        postDispatchHoldMs: 0,
      })

      // then
      expect(first.status).toBe("dispatched")
      expect(second).toEqual({
        status: "queued",
        queuedBy: "test:coalesce-kind:delivered:first",
        position: 0,
        coalesceKind: "already-delivered",
      })
      if (second.status !== "queued") {
        throw new Error("expected coalesced duplicate to report queued")
      }
      expect(second.coalesceKind).toBe("already-delivered")
      expect(promptCalls).toEqual(["prompt"])
    } finally {
      Date.now = originalDateNow
    }
  })

  test("#given an identical prompt reserved and dispatching right now #when a duplicate enqueues #then the coalesced result names coalesceKind in-flight", async () => {
    // given
    let promptCalls = 0
    let releaseFirstPrompt: (() => void) | undefined
    let resolveFirstSeen: (() => void) | undefined
    const firstSeen = new Promise<void>((resolve) => {
      resolveFirstSeen = resolve
    })
    const firstGate = new Promise<void>((resolve) => {
      releaseFirstPrompt = resolve
    })
    const input = {
      path: { id: "ses_coalesce_kind_in_flight" },
      body: { parts: [{ type: "text", text: "wake" }] },
    }
    const client = {
      session: {
        promptAsync: async () => {
          promptCalls += 1
          resolveFirstSeen?.()
          await firstGate
        },
      },
    }

    // when
    const firstPending = dispatchInternalPrompt({
      mode: "async",
      client,
      sessionID: "ses_coalesce_kind_in_flight",
      input,
      source: "test:coalesce-kind:in-flight:first",
      settleMs: 0,
      postDispatchHoldMs: 0,
      semanticDedupeHoldMs: 0,
    })
    await firstSeen
    const second = await dispatchInternalPrompt({
      mode: "async",
      client,
      sessionID: "ses_coalesce_kind_in_flight",
      input,
      source: "test:coalesce-kind:in-flight:second",
      settleMs: 0,
      postDispatchHoldMs: 0,
      semanticDedupeHoldMs: 0,
    })
    releaseFirstPrompt?.()
    const first = await firstPending

    // then
    expect(first.status).toBe("dispatched")
    expect(second).toEqual({
      status: "queued",
      queuedBy: "test:coalesce-kind:in-flight:first",
      position: 0,
      coalesceKind: "in-flight",
    })
    if (second.status !== "queued") {
      throw new Error("expected in-flight duplicate to report queued")
    }
    expect(second.coalesceKind).toBe("in-flight")
    expect(promptCalls).toBe(1)
  })

  test("#given an identical prompt already waiting in the queue #when a duplicate enqueues behind it #then the coalesced result names coalesceKind in-flight", async () => {
    // given
    let promptCalls = 0
    const input = {
      path: { id: "ses_coalesce_kind_pending" },
      body: { parts: [{ type: "text", text: "wake" }] },
    }
    const client = {
      session: {
        status: async () => ({ data: { ses_coalesce_kind_pending: { type: "busy" } } }),
        promptAsync: async () => {
          promptCalls += 1
        },
      },
    }

    // when
    const first = await dispatchInternalPrompt({
      mode: "async",
      client,
      sessionID: "ses_coalesce_kind_pending",
      input,
      source: "test:coalesce-kind:pending:first",
      settleMs: 0,
      queueRetryMs: 60_000,
    })
    const second = await dispatchInternalPrompt({
      mode: "async",
      client,
      sessionID: "ses_coalesce_kind_pending",
      input,
      source: "test:coalesce-kind:pending:second",
      settleMs: 0,
      queueRetryMs: 60_000,
    })

    // then
    expect(first.status).toBe("queued")
    if (first.status !== "queued") {
      throw new Error("expected first prompt to stay queued behind the busy session")
    }
    expect(Object.hasOwn(first, "coalesceKind")).toBe(false)
    expect(second).toEqual({
      status: "queued",
      queuedBy: "test:coalesce-kind:pending:first",
      position: 1,
      coalesceKind: "in-flight",
    })
    if (second.status !== "queued") {
      throw new Error("expected pending duplicate to report queued")
    }
    expect(second.coalesceKind).toBe("in-flight")
    expect(promptCalls).toBe(0)
  })

  test("#given a fresh prompt with no duplicate anywhere #when it dispatches #then the result carries no coalesceKind property at all", async () => {
    // given
    let promptCalls = 0
    const client = {
      session: {
        promptAsync: async () => {
          promptCalls += 1
          return { accepted: true }
        },
      },
    }

    // when
    const result = await dispatchInternalPrompt({
      mode: "async",
      client,
      sessionID: "ses_coalesce_kind_fresh",
      input: {
        path: { id: "ses_coalesce_kind_fresh" },
        body: { parts: [{ type: "text", text: "wake" }] },
      },
      source: "test:coalesce-kind:fresh",
      settleMs: 0,
      postDispatchHoldMs: 0,
    })

    // then
    expect(result.status).toBe("dispatched")
    expect(Object.hasOwn(result, "coalesceKind")).toBe(false)
    expect(promptCalls).toBe(1)
  })
})
