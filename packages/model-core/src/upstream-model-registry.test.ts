import { beforeEach, describe, expect, test } from "bun:test"

import {
  _resetObservedUpstreamModelsForTesting,
  getObservedUpstreamModel,
  readUpstreamModelHeader,
  recordObservedUpstreamModel,
  resolveModelForFamilyDetection,
} from "./upstream-model-registry"
import { isGptModel } from "./model-family-detectors"

describe("observed upstream model registry", () => {
  beforeEach(() => {
    _resetObservedUpstreamModelsForTesting()
  })

  describe("#given nothing has been observed yet", () => {
    test("#when detection resolves a model #then the configured id passes through unchanged", () => {
      expect(resolveModelForFamilyDetection("onara/oracle")).toBe("onara/oracle")
      expect(getObservedUpstreamModel("onara/oracle")).toBeUndefined()
    })
  })

  describe("#given a proxy alias whose upstream was observed", () => {
    test("#when detection resolves it #then the observed upstream is used", () => {
      // The bug this exists for: onara/momus carries no vendor hint, so isGptModel
      // is false and a GPT-backed agent gets the Claude-shaped prompt.
      expect(isGptModel("onara/momus")).toBe(false)

      recordObservedUpstreamModel("onara/momus", "openai/gpt-5.6-sol")

      const resolved = resolveModelForFamilyDetection("onara/momus")
      expect(resolved).toBe("openai/gpt-5.6-sol")
      expect(isGptModel(resolved)).toBe(true)
    })
  })

  describe("#given a combo that falls back to another vendor mid-session", () => {
    test("#when the newer response is recorded #then detection follows the vendor that actually served", () => {
      // This is why a static family override cannot work: the family changes at
      // runtime when a quota is exhausted, with no config change to trigger on.
      recordObservedUpstreamModel("onara/oracle", "anthropic/claude-opus-5")
      expect(isGptModel(resolveModelForFamilyDetection("onara/oracle"))).toBe(false)

      recordObservedUpstreamModel("onara/oracle", "openai/gpt-5.6-sol")

      expect(resolveModelForFamilyDetection("onara/oracle")).toBe("openai/gpt-5.6-sol")
      expect(isGptModel(resolveModelForFamilyDetection("onara/oracle"))).toBe(true)
    })
  })

  describe("#given entries for different configured models", () => {
    test("#when one is recorded #then the others are unaffected", () => {
      recordObservedUpstreamModel("onara/oracle", "anthropic/claude-opus-5")
      recordObservedUpstreamModel("onara/momus", "openai/gpt-5.6-sol")

      expect(resolveModelForFamilyDetection("onara/oracle")).toBe("anthropic/claude-opus-5")
      expect(resolveModelForFamilyDetection("onara/momus")).toBe("openai/gpt-5.6-sol")
      expect(resolveModelForFamilyDetection("onara/deep")).toBe("onara/deep")
    })
  })

  describe("#given junk input", () => {
    test("#when recorded #then nothing is stored and the configured id still passes through", () => {
      recordObservedUpstreamModel("onara/oracle", undefined)
      recordObservedUpstreamModel("onara/oracle", "")
      recordObservedUpstreamModel("onara/oracle", "   ")
      recordObservedUpstreamModel("", "openai/gpt-5.6-sol")

      expect(resolveModelForFamilyDetection("onara/oracle")).toBe("onara/oracle")
    })
  })

  describe("#given response headers", () => {
    test("#when the proxy reported an upstream model #then it is read case-insensitively", () => {
      const headers = new Headers({ "X-9Router-Upstream-Model": "openai/gpt-5.6-sol" })

      expect(readUpstreamModelHeader(headers)).toBe("openai/gpt-5.6-sol")
    })

    test("#when the header is absent #then nothing is reported", () => {
      expect(readUpstreamModelHeader(new Headers())).toBeUndefined()
    })

    test("#when reading headers throws #then it degrades to undefined rather than breaking the response", () => {
      const hostile = {
        get(): string | null {
          throw new Error("headers unavailable")
        },
      }

      expect(readUpstreamModelHeader(hostile)).toBeUndefined()
    })
  })
})
