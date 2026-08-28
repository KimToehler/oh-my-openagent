import { beforeEach, describe, expect, test } from "bun:test"

import { _resetObservedUpstreamModelsForTesting, isGptModel } from "@oh-my-opencode/model-core"

import { createOracleAgent } from "../agents/oracle"
import { installUpstreamModelObserver } from "./upstream-model-observer"

/**
 * Build a provider config whose fetch reports `servedBy`, wrapped by the observer
 * exactly as the config hook wraps it in production, then drive one request.
 */
async function driveTurn(servedBy: string, model: string): Promise<void> {
  const config: Record<string, unknown> = {
    provider: {
      onara: {
        options: {
          fetch: async () => new Response("{}", { headers: { "X-9Router-Upstream-Model": servedBy } }),
        },
      },
    },
  }
  installUpstreamModelObserver(config)

  const providers = config.provider as Record<string, { options: Record<string, unknown> }>
  const wrapped = providers.onara?.options.fetch as (input: unknown, init?: unknown) => Promise<Response>
  await wrapped("https://router.example/v1/chat/completions", {
    body: JSON.stringify({ model, messages: [] }),
  })
}

describe("upstream model detection end to end", () => {
  beforeEach(() => {
    _resetObservedUpstreamModelsForTesting()
  })

  test("#given an opaque alias served by GPT #when a turn completes #then the agent is rebuilt with the GPT shape", async () => {
    // The live defect: the alias names an agent role, not a vendor, so every family
    // detector returns false and a GPT-backed agent is built Claude-shaped.
    expect(isGptModel("onara/momus")).toBe(false)
    const before = createOracleAgent("onara/momus")
    expect(before.reasoningEffort).toBeUndefined()

    await driveTurn("openai/gpt-5.6-sol", "momus")

    expect(isGptModel("onara/momus")).toBe(true)
    const after = createOracleAgent("onara/momus")
    expect(after.reasoningEffort).toBe("xhigh")
    expect(after.textVerbosity).toBe("high")
    expect(after.prompt).not.toBe(before.prompt)
  })

  test("#given a combo that falls back to Anthropic #when the newer turn completes #then the agent reverts to the Claude shape", async () => {
    // A static family override cannot express this: the vendor changes at runtime
    // when a quota is exhausted, with no config change to react to.
    await driveTurn("openai/gpt-5.6-sol", "oracle")
    expect(createOracleAgent("onara/oracle").reasoningEffort).toBe("xhigh")

    await driveTurn("anthropic/claude-opus-5", "oracle")

    expect(isGptModel("onara/oracle")).toBe(false)
    expect(createOracleAgent("onara/oracle").reasoningEffort).toBeUndefined()
  })

  test("#given no turn has completed #then behavior is unchanged from before this feature", () => {
    const agent = createOracleAgent("onara/oracle")

    expect(isGptModel("onara/oracle")).toBe(false)
    expect(agent.reasoningEffort).toBeUndefined()
  })
})
