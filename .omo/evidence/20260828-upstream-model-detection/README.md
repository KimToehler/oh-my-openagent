# Detect model family from the model that actually served the request

## The defect

Family detection (`isGptModel`, `isGpt5_6Model`, ...) matches on the text of the
configured model id. That works for `openai/gpt-5.6-sol` and fails completely for a
proxy alias like `onara/momus`, which names an agent role rather than a vendor:
every detector returns false, so a GPT-backed agent was built with the Claude-shaped
prompt, no `reasoningEffort`, no `textVerbosity`, and the wrong frontier tool
restrictions. Verified live: `onara/momus` and `onara/ultrabrain` are served by
`gpt-5.6-sol`, and both were being treated as non-GPT.

## Why the obvious fixes do not work

**A static family override in config** was the first plan and is wrong. A combo may
route one alias to several vendors and fall through when a quota is exhausted, so
the family changes at runtime with no config change to react to. A declaration would
be silently wrong exactly when a fallback fires - worse than the current bug,
because it looks fixed.

**Reading a response header from a plugin hook** is not possible. Every hook is
request-side: `chat.headers` only sets outgoing headers, and `chat.params` options
become the AI SDK's `providerOptions`, which is request *body* (confirmed by reading
the shipped 1.18.20 binary: `providerOptions: ke.providerOptions(y.model,
h.params.options)`). `ApiError.data.responseHeaders` exists but only on failures.

## What was implemented

Provider construction options are a different object, and OpenCode spreads them
straight into the SDK, which honors a `fetch` override there - opencode's own
Snowflake provider uses exactly this (`provider.ts:941`, reading `response.headers`
at `:970`, and `delete options.fetch` at `:1748` proving the SDK consumes it). Those
options come from config, and plugins can mutate config.

So the `config` hook installs a fetch wrapper per provider. On each response it
records the model that actually served, keyed by the configured id, and family
detection resolves through that registry. Last write wins, which is what a
mid-session fallback looks like.

Two signals, in priority order:
1. `X-9Router-Upstream-Model` response header (explicit; added to 9router in
   `f8975da3` / `33d91864`, not yet deployed).
2. The OpenAI-compatible response body's `"model"` field - which the live router
   **already** fills correctly, so this works today with no proxy change.

The body is read from a `clone()`; consuming `response.body` would hand the caller a
drained stream. Streaming responses are skipped by content-type.

## What was tested

- `packages/model-core/src/upstream-model-registry.test.ts` - registry semantics,
  including last-write-wins for a mid-session fallback.
- `packages/omo-opencode/src/plugin-handlers/upstream-model-observer.test.ts` -
  header path, body path, header-wins-over-body, stream body not consumed, caller
  still gets a readable body, error propagation, idempotent install, existing
  provider `fetch` preserved.
- `packages/omo-opencode/src/plugin-handlers/upstream-model-detection.test.ts` -
  end to end through `createConfigHandler`, proving a response observation
  invalidates the cached roster and re-invokes `createBuiltinAgents`; also covers
  the fallback reverting the agent to the Claude shape.
- **Live** against the deployed router - see `live-router-proof.txt`.

## What was observed

Live, through the real wrapper (`live-router-proof.txt`):

```
onara/momus   resolved onara/gpt-5.6-sol    isGptModel false -> true   reasoningEffort undefined -> xhigh   prompt changed
onara/oracle  resolved onara/claude-opus-5  isGptModel false -> false  reasoningEffort undefined -> undefined
```

`momus` gains the GPT prompt and `xhigh` effort; `oracle` correctly stays
Claude-shaped, which shows the mechanism discriminates rather than flipping
everything to GPT.

Gates: 996 pass / 0 fail across `model-core`, `agents`, and `plugin-handlers`;
typecheck clean.

## Review round 2: the fix recorded the truth but did not apply it

An independent review rejected the first version, and reproduced the defect. Agent
prompts, reasoning effort, and tool restrictions are baked into a roster that
`config-handler.ts` memoizes on a cache key of `{agent, default_agent, model,
skills}`. The registry was not in that key, so once the roster was built with the
alias unresolved, every later config-hook run replayed the stale clone and
`createOracleAgent` was never called again.

Worse, the original test could not catch it: it called `createOracleAgent` directly,
proving the factory is a pure function of the registry - which was never in doubt -
while its name claimed the agent was rebuilt. The first live proof had the same gap.

Fixed:
- `createAgentConfigCacheKey` now folds in `collectResolvedModelIdentity(config)`, so
  an observation invalidates the cached roster.
- `upstream-model-detection.test.ts` drives `createConfigHandler` and asserts
  `createBuiltinAgents` is invoked again. Reverting only the cache-key line makes it
  fail (1 fail / 4 pass), so it guards behavior rather than factory purity.
- The direct-provider guard compared a qualified observation against a bare
  requested id, so every direct Anthropic/OpenAI call recorded a useless
  self-mapping and logged a misleading redirect. Both sides are now qualified;
  verified that a direct provider records nothing while a real redirect still does.
- The body read is no longer awaited. It was delaying every non-streaming response
  by a full extra parse for a side effect with no ordering requirement.

## Why it is enough

The failing behavior was reproduced live, the fix was verified live against the same
router with real credentials, and the negative case (`oracle`) proves it is not a
blanket change. Before any response the configured id passes through unchanged, so
first-turn behavior is identical to today and this can only improve accuracy.

Residual risk: the first request of a session is still shaped by the configured id,
since nothing has been observed yet - unavoidable without a response. A provider that
reports a normalized or generic `"model"` would record a useless value; the header
takes priority precisely so an explicit signal can override that.

## What was omitted

The router API key was read from `~/.local/share/opencode/auth.json` at run time and
never printed, logged, or written to any evidence file. No credentials, tokens, or
env dumps appear in these artifacts.
