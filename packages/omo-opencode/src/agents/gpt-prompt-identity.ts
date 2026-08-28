import { ModelFamily, type ModelFamily as ModelFamilyName } from "@oh-my-opencode/model-core"

export type GptPromptIdentityKey = "gpt-5.5" | "gpt-5.6" | "gpt-5.6-sol" | "gpt-family"

const GPT_PROMPT_IDENTITIES: Record<GptPromptIdentityKey, string> = {
  "gpt-5.5": "GPT-5.5",
  "gpt-5.6": "GPT-5.6",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-family": "a GPT-family model",
}

export function getGptPromptIdentityKey(
  model?: string,
  modelFamily?: ModelFamilyName,
): GptPromptIdentityKey {
  if (modelFamily === ModelFamily.Gpt56) return "gpt-5.6"
  if (modelFamily === ModelFamily.Gpt55) return "gpt-5.5"

  const modelID = model?.split("/").at(-1)?.toLowerCase()

  if (modelID?.includes("gpt-5.6-sol") || modelID?.includes("gpt-5-6-sol")) {
    return "gpt-5.6-sol"
  }
  if (modelID?.includes("gpt-5.5") || modelID?.includes("gpt-5-5")) {
    return "gpt-5.5"
  }
  return "gpt-family"
}

export function getGptPromptIdentity(model?: string, modelFamily?: ModelFamilyName): string {
  return GPT_PROMPT_IDENTITIES[getGptPromptIdentityKey(model, modelFamily)]
}
