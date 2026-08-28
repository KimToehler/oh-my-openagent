import { readUpstreamModelHeader, recordObservedUpstreamModel } from "@oh-my-opencode/model-core"

import { log } from "../shared"

/**
 * Wrap each configured provider's `fetch` so the model that actually served a
 * response is recorded.
 *
 * OpenCode exposes no response-side hook: `chat.headers` only sets outgoing
 * headers, and `chat.params` options become the AI SDK's `providerOptions`, which
 * is request body. Provider construction options are different - OpenCode spreads
 * them straight into the SDK client, and the SDK honors a `fetch` override there
 * (opencode's own Snowflake provider uses exactly this to rewrite responses).
 * Injecting the wrapper from the `config` hook is therefore the only supported way
 * to observe a successful response, and it was verified end to end against a live
 * session before this shipped.
 *
 * Only proxied/aliased ids benefit, but the wrapper is applied to every configured
 * provider: whether an id is opaque is not knowable here, and a concrete id simply
 * records itself.
 */

type ProviderEntry = {
  options?: Record<string, unknown>
  models?: Record<string, unknown>
}

type FetchLike = (input: unknown, init?: unknown) => Promise<Response>

const WRAPPED = Symbol.for("omo.upstreamModelObserver.wrapped")

function requestedModelFrom(init: unknown): string | undefined {
  if (typeof init !== "object" || init === null) return undefined
  const body = (init as { body?: unknown }).body
  if (typeof body !== "string") return undefined
  try {
    const parsed = JSON.parse(body) as { model?: unknown }
    return typeof parsed.model === "string" ? parsed.model : undefined
  } catch {
    return undefined
  }
}

function qualify(model: string, providerID: string): string {
  // A proxy may report a bare id ("claude-opus-5") or a qualified one
  // ("anthropic/claude-opus-5"). Family detection reads the last path segment, so a
  // bare id already works; qualify it only to keep the recorded value readable.
  return model.includes("/") ? model : `${providerID}/${model}`
}

/**
 * Read the served model from a non-streaming JSON body.
 *
 * An OpenAI-compatible response carries `"model"`, and a proxy fills it with what it
 * actually used: requesting the combo `oracle` against the live router returns
 * `"model":"claude-opus-5"`, while `momus` returns `"gpt-5.6-sol"`. That makes the
 * body the broadest signal - it needs no cooperation from the proxy - so it is
 * tried first and the header is treated as a more explicit override.
 *
 * The body is read from a CLONE. Consuming `response.body` here would leave the
 * caller an empty stream.
 */
async function observedModelFromBody(response: Response, providerID: string): Promise<string | undefined> {
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) return undefined
  try {
    const parsed = (await response.clone().json()) as { model?: unknown }
    if (typeof parsed.model !== "string" || parsed.model.trim() === "") return undefined
    return qualify(parsed.model.trim(), providerID)
  } catch {
    return undefined
  }
}

function observedModelFromHeader(response: Response, providerID: string): string | undefined {
  const fromHeader = readUpstreamModelHeader(response.headers)
  return fromHeader === undefined ? undefined : qualify(fromHeader, providerID)
}

/**
 * Wrap one provider's fetch. Never throws and never alters the response: the
 * observation is a side effect, and a failure to identify a model must not break a
 * working request.
 */
export function wrapProviderFetch(providerID: string, existing: FetchLike | undefined): FetchLike {
  const base: FetchLike =
    existing ?? ((input, init) => fetch(input as Parameters<typeof fetch>[0], init as RequestInit))

  const wrapped: FetchLike = async (input, init) => {
    const response = await base(input, init)
    try {
      const configuredModel = requestedModelFrom(init)
      if (configuredModel !== undefined) {
        const observed =
          observedModelFromHeader(response, providerID) ?? (await observedModelFromBody(response, providerID))
        if (observed !== undefined && observed !== configuredModel) {
          recordObservedUpstreamModel(`${providerID}/${configuredModel}`, observed)
          recordObservedUpstreamModel(configuredModel, observed)
          log(`[upstream-model] ${providerID}/${configuredModel} served by ${observed}`)
        }
      }
    } catch {
      // Observation is best-effort; the response is already the caller's.
    }
    return response
  }

  Object.defineProperty(wrapped, WRAPPED, { value: true, enumerable: false })
  return wrapped
}

function isWrapped(value: unknown): boolean {
  return typeof value === "function" && (value as unknown as Record<symbol, unknown>)[WRAPPED] === true
}

/**
 * Install the observer on every configured provider.
 *
 * Idempotent: the `config` hook runs more than once per process, and re-wrapping a
 * wrapper on each call would build an unbounded chain of closures around one fetch.
 */
export function installUpstreamModelObserver(config: Record<string, unknown>): void {
  const providers = config.provider as Record<string, ProviderEntry> | undefined | null
  if (providers === undefined || providers === null || typeof providers !== "object") return

  for (const [providerID, provider] of Object.entries(providers)) {
    if (provider === null || typeof provider !== "object") continue
    const options = (provider.options ?? {}) as Record<string, unknown>
    if (isWrapped(options.fetch)) continue
    options.fetch = wrapProviderFetch(providerID, options.fetch as FetchLike | undefined)
    provider.options = options
  }
}
