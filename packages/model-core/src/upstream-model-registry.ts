/**
 * Records the model a provider actually served, so family detection stops
 * guessing from an opaque id.
 *
 * Family detection (`isGptModel`, `isGpt5_6Model`, ...) matches on the text of the
 * configured model id. That works for `openai/gpt-5.6-sol` and fails completely for
 * a proxy alias such as `onara/oracle`, which carries no vendor hint: every detector
 * returns false, so a GPT-backed agent silently receives the Claude-shaped prompt,
 * the wrong reasoning effort, and the wrong tool restrictions.
 *
 * A static mapping cannot fix this. A proxy may route one alias to several vendors
 * and fall through between them when a quota is exhausted, so the true family is a
 * property of the response, not of configuration.
 *
 * The registry therefore stores what was observed on the wire, keyed by the
 * configured model id. It is a cache of fact, not a source of truth: an entry
 * appears only after a real response reported one, and is overwritten whenever a
 * later response reports something else - which is exactly what a mid-session
 * fallback looks like.
 */

const observedByConfiguredModel = new Map<string, string>()

/** Response header a proxy can set to name the model that actually served a request. */
export const UPSTREAM_MODEL_HEADER = "x-9router-upstream-model"

function normalize(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Record the model a response reported for a configured model id.
 *
 * Last write wins on purpose. When a combo falls back from Anthropic to OpenAI
 * mid-session, the newest observation is the correct one and the previous entry is
 * stale by definition.
 */
export function recordObservedUpstreamModel(configuredModel: string, observedModel: string | undefined): void {
  const key = normalize(configuredModel)
  const observed = normalize(observedModel)
  if (key === undefined || observed === undefined) return
  observedByConfiguredModel.set(key, observed)
}

/**
 * The last model observed for a configured id, or undefined when nothing has been
 * observed yet - notably before the first response of a session.
 */
export function getObservedUpstreamModel(configuredModel: string): string | undefined {
  const key = normalize(configuredModel)
  if (key === undefined) return undefined
  return observedByConfiguredModel.get(key)
}

/**
 * The id family detection should run against: the observed upstream when one exists,
 * otherwise the configured id unchanged.
 *
 * Callers stay unaware of the registry; they keep passing a model id and get correct
 * answers once the vendor is known.
 */
export function resolveModelForFamilyDetection(configuredModel: string): string {
  return getObservedUpstreamModel(configuredModel) ?? configuredModel
}

/** Extract the upstream model from response headers, if the proxy reported one. */
export function readUpstreamModelHeader(headers: {
  get(name: string): string | null
}): string | undefined {
  try {
    return normalize(headers.get(UPSTREAM_MODEL_HEADER))
  } catch {
    return undefined
  }
}

export function _resetObservedUpstreamModelsForTesting(): void {
  observedByConfiguredModel.clear()
}
