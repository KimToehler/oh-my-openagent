import type { BuildSystemContentInput } from "./types"
import type { AvailableSkill } from "../../agents/dynamic-agent-prompt-builder"
import { buildPlanAgentSystemPrepend, isPlanAgent } from "./constants"
import { buildSystemContentWithTokenLimit } from "./token-limiter"

const FREE_OR_LOCAL_PROMPT_TOKEN_LIMIT = 24000
const PLAN_AGENT_PROMPT_BASE = `

Additional requirements for this planning request:
- Answer in English.
- Write the plan in English.
- Plan well for ultrawork execution.
- Include a clear atomic commit strategy.`

const TDD_LINE = "- Use TDD-oriented planning."
const EVIDENCE_REPORTING = `<evidence-reporting>
When you report a test, mutation-test, build, or QA result, PASTE the actual tool output verbatim: the command you ran, the real pass/fail lines, the test/assertion counts, and the full failure text. Do not describe, paraphrase, or summarize it.
A summarized result is not evidence and will be treated as unverified, because an honest summary and a fabricated one are indistinguishable at review. If output is long, paste the decisive lines verbatim and give the artifact path for the rest.
</evidence-reporting>`
const BACKGROUND_BLOCKED_REPORTING = `<background-subagent-tools>
If blocked and parent input is required, call report_blocked with both reason and needs. Use this only for genuine blocks: missing credentials, a decision only the parent can make, missing API, or clarification. Do not use this for waiting on a long-running or detached job - poll instead. This alerts parent and parks this background task until parent resumes it.
</background-subagent-tools>`

function buildPlanAgentPromptAppend(tddEnabled: boolean): string {
  if (tddEnabled) {
    return `${PLAN_AGENT_PROMPT_BASE}
${TDD_LINE}`
  }
  return PLAN_AGENT_PROMPT_BASE
}

function mergeNativeIntoAvailable(
  skills: AvailableSkill[],
  nativeSkillInfos: { name: string; description: string; location: string }[] | undefined,
): AvailableSkill[] {
  if (!nativeSkillInfos || nativeSkillInfos.length === 0) return skills
  const knownNames = new Set(skills.map((s) => s.name))
  const merged = [...skills]
  for (const native of nativeSkillInfos) {
    if (knownNames.has(native.name)) continue
    merged.push({ name: native.name, description: native.description, location: "user" })
    knownNames.add(native.name)
  }
  return merged
}

function usesFreeOrLocalModel(model: { providerID: string; modelID: string; variant?: string } | undefined): boolean {
  if (!model) {
    return false
  }

  const provider = model.providerID.toLowerCase()
  const modelId = model.modelID.toLowerCase()
  return provider.includes("local")
    || provider === "ollama"
    || provider === "lmstudio"
    || modelId.includes("free")
}

/**
 * Build the system content to inject into the agent prompt.
 * Combines skill content, category prompt append, and plan agent system prepend.
 */
export function buildSystemContent(input: BuildSystemContentInput): string | undefined {
  const {
    skillContent,
    skillContents,
    categoryPromptAppend,
    agentsContext,
    maxPromptTokens,
    model,
    agentName,
    availableCategories,
    availableSkills,
    nativeSkillInfos,
  } = input

  const effectiveAvailableSkills = mergeNativeIntoAvailable(availableSkills ?? [], nativeSkillInfos)

  const isPlan = isPlanAgent(agentName)
  const planAgentPrepend = isPlan
    ? buildPlanAgentSystemPrepend(availableCategories, effectiveAvailableSkills)
    : ""

  const effectiveAgentsContext = agentsContext ?? planAgentPrepend

  const effectiveMaxPromptTokens = maxPromptTokens
    ?? (usesFreeOrLocalModel(model) ? FREE_OR_LOCAL_PROMPT_TOKEN_LIMIT : undefined)

  return buildSystemContentWithTokenLimit(
    {
      skillContent,
      skillContents,
      categoryPromptAppend,
      agentsContext: effectiveAgentsContext,
      planAgentPrepend,
    },
    effectiveMaxPromptTokens
  )
}

/**
 * The identity seam: a non-plan prompt is returned UNCHANGED, and a plan prompt
 * gets guidance appended as a suffix, never a rewrite. Upstream pins both
 * properties by test, and they are worth keeping - a prompt builder that
 * silently rewrites its input is untestable at the boundary.
 *
 * Prefixes that every delegated task needs are composed in
 * `buildDelegatedTaskPrompt` instead, so this function stays pure.
 */
export function buildTaskPrompt(prompt: string, agentName: string | undefined, tddEnabled?: boolean): string {
  if (!isPlanAgent(agentName)) {
    return prompt
  }

  const effectiveTdd = tddEnabled ?? true
  return `${prompt}${buildPlanAgentPromptAppend(effectiveTdd)}`
}

/**
 * What a delegated task actually receives: the evidence-reporting contract in
 * front of the task prompt. Split from `buildTaskPrompt` so the seam above can
 * stay an identity function while every real dispatch still carries the prefix.
 */
export function buildDelegatedTaskPrompt(
  prompt: string,
  agentName: string | undefined,
  tddEnabled?: boolean,
): string {
  return `${EVIDENCE_REPORTING}\n\n${buildTaskPrompt(prompt, agentName, tddEnabled)}`
}

export function buildBackgroundTaskPrompt(prompt: string, agentName: string | undefined, tddEnabled?: boolean): string {
  return `${BACKGROUND_BLOCKED_REPORTING}\n\n${buildDelegatedTaskPrompt(prompt, agentName, tddEnabled)}`
}
