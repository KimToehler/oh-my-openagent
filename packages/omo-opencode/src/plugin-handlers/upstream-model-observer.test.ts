import { beforeEach, describe, expect, test } from "bun:test"

import {
  _resetObservedUpstreamModelsForTesting,
  getObservedUpstreamModel,
  resolveModelForFamilyDetection,
} from "@oh-my-opencode/model-core"

import { installUpstreamModelObserver, wrapProviderFetch } from "./upstream-model-observer"

function jsonResponse(headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: true }), { headers })
}

function chatInit(model: string): { body: string } {
  return { body: JSON.stringify({ model, messages: [] }) }
}

describe("upstream model observer", () => {
  beforeEach(() => {
    _resetObservedUpstreamModelsForTesting()
  })

  describe("#given a response naming the model that served it", () => {
    test("#when the wrapped fetch returns #then the observation is recorded for the requested id", async () => {
      const wrapped = wrapProviderFetch("onara", async () =>
        jsonResponse({ "X-9Router-Upstream-Model": "openai/gpt-5.6-sol" }),
      )

      await wrapped("https://router.example/v1/chat/completions", chatInit("momus"))

      expect(getObservedUpstreamModel("onara/momus")).toBe("openai/gpt-5.6-sol")
      expect(resolveModelForFamilyDetection("onara/momus")).toBe("openai/gpt-5.6-sol")
    })
  })

  describe("#given a combo that falls back between vendors", () => {
    test("#when a later response names a different model #then the newest observation wins", async () => {
      const responses = ["anthropic/claude-opus-5", "openai/gpt-5.6-sol"]
      let call = 0
      const wrapped = wrapProviderFetch("onara", async () =>
        jsonResponse({ "X-9Router-Upstream-Model": responses[call++] ?? "" }),
      )

      await wrapped("https://router.example/v1/chat/completions", chatInit("oracle"))
      expect(resolveModelForFamilyDetection("onara/oracle")).toBe("anthropic/claude-opus-5")

      await wrapped("https://router.example/v1/chat/completions", chatInit("oracle"))
      expect(resolveModelForFamilyDetection("onara/oracle")).toBe("openai/gpt-5.6-sol")
    })
  })

  describe("#given a bare model id in the header", () => {
    test("#when recorded #then it is qualified with the provider", async () => {
      const wrapped = wrapProviderFetch("onara", async () =>
        jsonResponse({ "X-9Router-Upstream-Model": "gpt-5.6-sol" }),
      )

      await wrapped("https://router.example/v1/chat/completions", chatInit("momus"))

      expect(getObservedUpstreamModel("onara/momus")).toBe("onara/gpt-5.6-sol")
    })
  })

  describe("#given a response without the header", () => {
    test("#when the body names the served model #then the body is used", async () => {
      // The live router already does this: requesting the combo `oracle` returns
      // {"model":"claude-opus-5"}. No proxy cooperation is required.
      const wrapped = wrapProviderFetch("onara", async () =>
        new Response(JSON.stringify({ model: "claude-opus-5", choices: [] }), {
          headers: { "Content-Type": "application/json" },
        }),
      )

      await wrapped("https://router.example/v1/chat/completions", chatInit("oracle"))

      expect(getObservedUpstreamModel("onara/oracle")).toBe("onara/claude-opus-5")
    })

    test("#when the body has no model either #then nothing is recorded", async () => {
      const wrapped = wrapProviderFetch("onara", async () => jsonResponse())

      await wrapped("https://router.example/v1/chat/completions", chatInit("oracle"))

      expect(getObservedUpstreamModel("onara/oracle")).toBeUndefined()
    })

    test("#when the body is read #then the caller still receives a consumable body", async () => {
      // The observer must clone; consuming response.body would hand the caller an
      // already-drained stream.
      const wrapped = wrapProviderFetch("onara", async () =>
        new Response(JSON.stringify({ model: "claude-opus-5", choices: [{ index: 0 }] }), {
          headers: { "Content-Type": "application/json" },
        }),
      )

      const response = await wrapped("https://router.example/v1/chat/completions", chatInit("oracle"))

      expect(await response.json()).toEqual({ model: "claude-opus-5", choices: [{ index: 0 }] })
    })

    test("#when the response is a stream #then the body is not consumed to inspect it", async () => {
      const encoder = new TextEncoder()
      const wrapped = wrapProviderFetch("onara", async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(encoder.encode("data: {}\n\n"))
              c.close()
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      )

      const response = await wrapped("https://router.example/v1/chat/completions", chatInit("oracle"))

      expect(await response.text()).toContain("data: {}")
    })
  })

  describe("#given both a header and a body model", () => {
    test("#when they disagree #then the explicit header wins", async () => {
      const wrapped = wrapProviderFetch("onara", async () =>
        new Response(JSON.stringify({ model: "body-model" }), {
          headers: {
            "Content-Type": "application/json",
            "X-9Router-Upstream-Model": "openai/gpt-5.6-sol",
          },
        }),
      )

      await wrapped("https://router.example/v1/chat/completions", chatInit("momus"))

      expect(getObservedUpstreamModel("onara/momus")).toBe("openai/gpt-5.6-sol")
    })
  })

  describe("#given the underlying fetch fails", () => {
    test("#when it rejects #then the error propagates unchanged", async () => {
      const wrapped = wrapProviderFetch("onara", async () => {
        throw new Error("upstream unreachable")
      })

      await expect(
        wrapped("https://router.example/v1/chat/completions", chatInit("oracle")),
      ).rejects.toThrow("upstream unreachable")
    })
  })

  describe("#given a response the observer cannot parse", () => {
    test("#when the body is not JSON #then the response is still returned intact", async () => {
      const wrapped = wrapProviderFetch("onara", async () => jsonResponse({ "X-9Router-Upstream-Model": "x/y" }))

      const response = await wrapped("https://router.example/v1/chat/completions", { body: "not-json" })

      expect(response.ok).toBe(true)
      expect(await response.json()).toEqual({ ok: true })
    })
  })

  describe("#given provider config", () => {
    test("#when the observer is installed #then every provider gains a fetch wrapper", () => {
      const config: Record<string, unknown> = {
        provider: {
          onara: { options: { baseURL: "https://router.example/v1" } },
          other: {},
        },
      }

      installUpstreamModelObserver(config)

      const providers = config.provider as Record<string, { options?: Record<string, unknown> }>
      expect(typeof providers.onara?.options?.fetch).toBe("function")
      expect(typeof providers.other?.options?.fetch).toBe("function")
      expect(providers.onara?.options?.baseURL).toBe("https://router.example/v1")
    })

    test("#when installed repeatedly #then the wrapper is not stacked", () => {
      // The config hook runs more than once per process; re-wrapping each time would
      // build an unbounded closure chain around one fetch.
      const config: Record<string, unknown> = { provider: { onara: { options: {} } } }

      installUpstreamModelObserver(config)
      const first = (config.provider as Record<string, { options: Record<string, unknown> }>).onara.options.fetch

      installUpstreamModelObserver(config)
      const second = (config.provider as Record<string, { options: Record<string, unknown> }>).onara.options.fetch

      expect(second).toBe(first)
    })

    test("#when a provider already defines fetch #then the existing one is still called", async () => {
      let userFetchCalled = false
      const config: Record<string, unknown> = {
        provider: {
          onara: {
            options: {
              fetch: async () => {
                userFetchCalled = true
                return jsonResponse({ "X-9Router-Upstream-Model": "openai/gpt-5.6-sol" })
              },
            },
          },
        },
      }

      installUpstreamModelObserver(config)
      const providers = config.provider as Record<string, { options: Record<string, unknown> }>
      const wrapped = providers.onara.options.fetch as (input: unknown, init?: unknown) => Promise<Response>
      await wrapped("https://router.example/v1/chat/completions", chatInit("momus"))

      expect(userFetchCalled).toBe(true)
      expect(getObservedUpstreamModel("onara/momus")).toBe("openai/gpt-5.6-sol")
    })

    test("#when config has no providers #then nothing throws", () => {
      expect(() => installUpstreamModelObserver({})).not.toThrow()
      expect(() => installUpstreamModelObserver({ provider: null })).not.toThrow()
    })
  })
})
