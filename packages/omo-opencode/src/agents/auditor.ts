import type { AgentConfig } from "@opencode-ai/sdk"
import type { AgentMode, AgentPromptMetadata } from "./types"
import { buildClaudeThinkingConfig, isGpt5_5Model, isGpt5_6Model, isGptModel } from "./types"
import { createAgentToolRestrictions, READ_ONLY_FILE_TOOLS } from "../shared/permission-compat"

const MODE: AgentMode = "subagent"

export const AUDITOR_PROMPT_METADATA: AgentPromptMetadata = {
  category: "advisor",
  cost: "EXPENSIVE",
  promptAlias: "Auditor",
  triggers: [
    {
      domain: "Implementation review",
      trigger: "Independent review of completed code or diffs",
    },
  ],
  useWhen: ["Independent implementation review", "Diff review", "Regression-risk review"],
  avoidWhen: ["Editing code", "Delegating follow-up work", "Simple file operations"],
}

const AUDITOR_PROMPT = `You are Auditor, an independent read-only implementation reviewer.

<mission>
Review supplied implementation and diffs for correctness, regressions, security, constraint violations, and missing verification. Read repository files and run only non-mutating investigation. Do not change files and do not delegate work.
</mission>

<review_method>
- Trace behavior from changed code through callers, types, tests, and configuration.
- Verify each finding with file and line evidence. Report only issues you can substantiate.
- Distinguish blockers from non-blocking risks. Do not invent defects or restate implementation.
- Check that tests exercise meaningful behavior, not only mocks or prompt prose.
</review_method>

<response>
Start with PASS, FAIL, or INCONCLUSIVE. For each blocker, give severity, file:line evidence, failure mode, and concrete fix direction. If no blocker exists, state what evidence was reviewed and residual risk.
</response>`

export function createAuditorAgent(model: string): AgentConfig {
  const restrictions = createAgentToolRestrictions(
    ["write", "edit", "apply_patch", "task", "call_omo_agent"],
    [...READ_ONLY_FILE_TOOLS],
  )

  const base = {
    description: "Read-only independent implementation and diff reviewer. (Auditor - OhMyOpenCode)",
    mode: MODE,
    model,
    temperature: 0.1,
    ...restrictions,
    prompt: AUDITOR_PROMPT,
  } as AgentConfig

  if (isGpt5_6Model(model)) {
    return { ...base, reasoningEffort: "xhigh" } as AgentConfig
  }

  if (isGpt5_5Model(model) || isGptModel(model)) {
    return { ...base, reasoningEffort: "medium" } as AgentConfig
  }

  return { ...base, ...buildClaudeThinkingConfig(model) } as AgentConfig
}

createAuditorAgent.mode = MODE
