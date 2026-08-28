import { describe, expect, test } from "bun:test"

import { createAuditorAgent } from "./auditor"

describe("createAuditorAgent", () => {
  test("denies all mutations and delegation while allowing read-only file tools", () => {
    // given
    const model = "openai/gpt-5.6-sol"

    // when
    const agent = createAuditorAgent(model)
    const permission = agent.permission as Record<string, string>

    // then
    expect(agent.mode).toBe("subagent")
    expect(permission["read"]).toBe("allow")
    expect(permission["grep"]).toBe("allow")
    expect(permission["glob"]).toBe("allow")
    for (const tool of ["write", "edit", "apply_patch", "task", "call_omo_agent"]) {
      expect(permission[tool]).toBe("deny")
    }
  })
})
