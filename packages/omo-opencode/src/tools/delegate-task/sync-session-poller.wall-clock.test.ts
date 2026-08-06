/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { pollSyncSession } from "./sync-session-poller"
import { runSyncTaskLoop } from "./sync-task-runner"
import { __resetTimingConfig, __setTimingConfig } from "./timing"
import type { OpencodeClient, ToolContextWithMetadata } from "./types"

const toolContext: ToolContextWithMetadata = {
  sessionID: "ses_parent",
  messageID: "msg_parent",
  agent: "sisyphus",
  abort: new AbortController().signal,
}

async function withMockedDateNow(stepMs: number, run: () => Promise<void>): Promise<void> {
  const originalDateNow = Date.now
  let now = 0
  Date.now = () => {
    const current = now
    now += stepMs
    return current
  }

  try {
    await run()
  } finally {
    Date.now = originalDateNow
  }
}

function createAlwaysRunningClient(sessionID: string, onAbort: () => void): OpencodeClient {
  return unsafeTestValue<OpencodeClient>({
    session: {
      abort: async () => {
        onAbort()
        return { data: {} }
      },
      messages: async () => ({ data: [] }),
      status: async () => ({ data: { [sessionID]: { type: "running" } } }),
    },
  })
}

afterEach(() => {
  __resetTimingConfig()
})

describe("pollSyncSession wall-clock yield", () => {
  test("#given continuously active session #when wall-clock bound elapses #then yields without aborting child", async () => {
    // given
    __setTimingConfig({ POLL_INTERVAL_MS: 1, MAX_POLL_TIME_MS: 60_000 })
    let abortCount = 0
    const client = createAlwaysRunningClient("ses_active", () => {
      abortCount++
    })

    // when
    await withMockedDateNow(10, async () => {
      const outcome = await pollSyncSession(toolContext, client, {
        sessionID: "ses_active",
        agentToUse: "sisyphus",
        toastManager: null,
        taskId: undefined,
        wallClockDeadline: 30,
      })

      // then
      expect(outcome).toEqual({ kind: "wall_clock_yield" })
      expect(abortCount).toBe(0)
    })
  })

  test("#given Infinity wall-clock default #when inactivity bound elapses #then returns normal error outcome", async () => {
    // given
    __setTimingConfig({ POLL_INTERVAL_MS: 1, MAX_POLL_TIME_MS: 50 })
    let abortCount = 0
    const client = unsafeTestValue<OpencodeClient>({
      session: {
        abort: async () => {
          abortCount++
          return { data: {} }
        },
        messages: async () => ({ data: [] }),
        status: async () => ({ data: { ses_default: { type: "idle" } } }),
      },
    })

    // when
    await withMockedDateNow(10, async () => {
      const outcome = await pollSyncSession(toolContext, client, {
        sessionID: "ses_default",
        agentToUse: "sisyphus",
        toastManager: null,
        taskId: undefined,
      })

      // then
      expect(outcome).toEqual({ kind: "error", message: "Poll inactivity timeout reached after 50ms without active OpenCode status for session ses_default" })
      expect(abortCount).toBe(1)
    })
  })


  test("#given fallback retry #when shared wall-clock deadline is reached #then second poll keeps original deadline", async () => {
    // given
    const deadlines: Array<number | undefined> = []
    let pollAttempt = 0
    const originalDateNow = Date.now
    Date.now = () => 100

    try {
      // when
      const outcome = await runSyncTaskLoop(unsafeTestValue({
        args: { description: "shared wall-clock task", prompt: "work", load_skills: [], run_in_background: false },
        ctx: toolContext,
        executorCtx: { client: { session: { abort: async () => ({ data: {} }) } }, directory: "/tmp", sisyphusAgentConfig: undefined },
        parentContext: { sessionID: "ses_parent", messageID: "msg_parent" },
        agentToUse: "sisyphus",
        categoryModel: { providerID: "openai", modelID: "first" },
        fallbackChain: [{ model: "second", providers: ["openai"] }],
        deps: {
          sendSyncPrompt: async () => null,
          pollSyncSession: async (_ctx: unknown, _client: unknown, input: { wallClockDeadline?: number }) => {
            deadlines.push(input.wallClockDeadline)
            pollAttempt++
            return pollAttempt === 1 ? { kind: "error" as const, message: "rate limit" } : { kind: "wall_clock_yield" as const }
          },
          fetchSyncResult: async () => ({ ok: false as const, error: "unexpected" }),
          createSyncSession: async () => ({ ok: true as const, sessionID: "ses_retry" }),
          isProviderExhaustionFallbackEligible: () => true,
        },
        sessionID: "ses_child",
        spawnDepth: 1,
        taskId: "sync_ses_child",
        startTime: new Date(0),
        syncPollTimeoutMs: undefined,
        syncWallClockTimeoutMs: 30,
        systemContent: undefined,
        toastManager: undefined,
        modelInfo: undefined,
        registerSyncSession: async () => {},
        publishSyncMetadata: async () => {},
        cleanupRetrySession: () => {},
        setSyncSessionID: () => {},
      }))

      // then
      expect(outcome).toEqual({ kind: "wall_clock_yield" })
      expect(deadlines).toEqual([130, 130])
    } finally {
      Date.now = originalDateNow
    }
  })

  test("#given poller yields #when runner handles outcome #then bypasses recovery and fallback", async () => {
    // given
    let fetchResultCalls = 0
    let fallbackEligibilityCalls = 0
    const outcome = await runSyncTaskLoop(unsafeTestValue({
      args: {
        description: "wall-clock task",
        prompt: "work",
        load_skills: [],
        run_in_background: false,
      },
      ctx: toolContext,
      executorCtx: {
        client: {
          session: { abort: async () => ({ data: {} }) },
        },
        directory: "/tmp",
        sisyphusAgentConfig: undefined,
      },
      parentContext: { sessionID: "ses_parent", messageID: "msg_parent" },
      agentToUse: "sisyphus",
      categoryModel: undefined,
      fallbackChain: undefined,
      deps: {
        sendSyncPrompt: async () => null,
        pollSyncSession: async () => ({ kind: "wall_clock_yield" }),
        fetchSyncResult: async () => {
          fetchResultCalls++
          return { ok: false as const, error: "unexpected fetch" }
        },
        createSyncSession: async () => ({ ok: false as const, error: "unexpected fallback" }),
        isProviderExhaustionFallbackEligible: () => {
          fallbackEligibilityCalls++
          return false
        },
      },
      sessionID: "ses_child",
      spawnDepth: 1,
      taskId: "sync_ses_child",
      startTime: new Date(0),
      syncPollTimeoutMs: undefined,
      syncWallClockTimeoutMs: 30,
      systemContent: undefined,
      toastManager: undefined,
      modelInfo: undefined,
      registerSyncSession: async () => {},
      publishSyncMetadata: async () => {},
      cleanupRetrySession: () => {},
      setSyncSessionID: () => {},
    }))

    // then
    expect(outcome).toEqual({ kind: "wall_clock_yield" })
    expect(fetchResultCalls).toBe(0)
    expect(fallbackEligibilityCalls).toBe(0)
  })
})
