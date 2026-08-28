import { describe, expect, test } from "bun:test"
import { AGENT_MODEL_REQUIREMENTS } from "@oh-my-opencode/model-core"
import { AGENT_ELIGIBILITY_REGISTRY } from "../../../team-core/src/types"
import { BUILTIN_AGENT_NAMES } from "../../../utils/src/migration/agent-names"
import { BuiltinAgentNameSchema } from "../config/schema/agent-names"
import { AGENT_NAMES } from "../hooks/runtime-fallback/agent-resolver"
import { TASK_DENIED_SUBAGENT_KEYS } from "../plugin-handlers/tool-config-handler"

const READ_ONLY_AGENT_NAMES = ["auditor", "oracle"] as const

describe("builtin agent registration completeness", () => {
  test("registers every built-in agent across runtime registries", () => {
    // given
    const builtinAgentNames = BuiltinAgentNameSchema.options

    // when / then
    for (const agentName of builtinAgentNames) {
      expect(AGENT_NAMES).toContain(agentName)
      expect(AGENT_ELIGIBILITY_REGISTRY[agentName]).toBeDefined()
      expect(BUILTIN_AGENT_NAMES.has(agentName)).toBe(true)
      expect(AGENT_MODEL_REQUIREMENTS[agentName]).toBeDefined()
    }

    for (const agentName of READ_ONLY_AGENT_NAMES) {
      expect(TASK_DENIED_SUBAGENT_KEYS).toContain(agentName)
      expect(AGENT_ELIGIBILITY_REGISTRY[agentName]?.verdict).toBe("hard-reject")
    }
    expect(AGENT_MODEL_REQUIREMENTS.auditor?.fallbackChain[0]?.model).toBe("claude-opus-5")
  })
})
