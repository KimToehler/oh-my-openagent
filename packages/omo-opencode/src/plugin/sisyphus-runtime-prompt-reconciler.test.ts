import { describe, expect, test } from "bun:test"

import { createSisyphusAgent } from "../agents/sisyphus"
import { createSystemTransformHandler } from "./system-transform"

const STATIC_ARCHITECTURE_MODEL = "openai/gpt-5.6"
const RUNTIME_RESPONSE_MODEL = "opencode-go/qwen3.7-plus"

describe("Sisyphus static startup prompt routing", () => {
  test("#given static GPT family startup prompt #when runtime response uses another model #then prompt remains byte-stable", async () => {
    // given
    const bakedPrompt = createSisyphusAgent(STATIC_ARCHITECTURE_MODEL, [], [], [], []).prompt ?? ""
    const handler = createSystemTransformHandler()
    const output = { system: [bakedPrompt] }

    // when
    await handler(
      { sessionID: "s", model: { id: RUNTIME_RESPONSE_MODEL, providerID: "opencode-go" } },
      output,
    )

    // then
    expect(output.system).toEqual([bakedPrompt])
  })
})
