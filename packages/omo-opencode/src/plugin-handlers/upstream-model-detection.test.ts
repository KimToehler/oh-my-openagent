/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"

import { _resetObservedUpstreamModelsForTesting, isGptModel } from "@oh-my-opencode/model-core"

import type { OhMyOpenCodeConfig } from "../config"
import * as agents from "../agents"
import * as commandLoader from "../features/claude-code-command-loader"
import * as builtinCommands from "../features/builtin-commands"
import * as skillLoader from "../features/opencode-skill-loader"
import * as agentLoader from "../features/claude-code-agent-loader"
import * as mcpLoader from "../features/claude-code-mcp-loader"
import * as pluginLoader from "../features/claude-code-plugin-loader"
import * as mcpModule from "../mcp"
import * as shared from "../shared"
import { setAgentSortOrder } from "../shared/agent-sort-shim"
import * as configDir from "../shared/opencode-config-dir"
import * as permissionCompat from "../shared/permission-compat"
import * as modelResolver from "../shared/model-resolver"
import * as configErrors from "../shared/config-errors"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import { createOracleAgent } from "../agents/oracle"
import { installUpstreamModelObserver } from "./upstream-model-observer"

let createConfigHandler: (typeof import("./config-handler"))["createConfigHandler"]

async function importFreshConfigHandlerModule(): Promise<typeof import("./config-handler")> {
  return import(`./config-handler?test=${Date.now()}-${Math.random()}`)
}

function createPluginConfig(): OhMyOpenCodeConfig {
  return {
    git_master: {
      commit_footer: true,
      include_co_authored_by: true,
      git_env_prefix: "GIT_MASTER=1",
    },
  }
}

beforeEach(async () => {
  mock.restore()
  configErrors.clearConfigLoadErrors()
  _resetObservedUpstreamModelsForTesting()

  spyOn(agents, unsafeTestValue("createBuiltinAgents")).mockResolvedValue({
    sisyphus: { name: "sisyphus", prompt: "test", mode: "primary" },
    oracle: { name: "oracle", prompt: "test", mode: "subagent" },
  })
  spyOn(commandLoader, unsafeTestValue("loadUserCommands")).mockResolvedValue({})
  spyOn(commandLoader, unsafeTestValue("loadProjectCommands")).mockResolvedValue({})
  spyOn(commandLoader, unsafeTestValue("loadOpencodeGlobalCommands")).mockResolvedValue({})
  spyOn(commandLoader, unsafeTestValue("loadOpencodeProjectCommands")).mockResolvedValue({})
  spyOn(builtinCommands, unsafeTestValue("loadBuiltinCommands")).mockReturnValue({})
  spyOn(skillLoader, unsafeTestValue("loadUserSkills")).mockResolvedValue({})
  spyOn(skillLoader, unsafeTestValue("loadProjectSkills")).mockResolvedValue({})
  spyOn(skillLoader, unsafeTestValue("loadOpencodeGlobalSkills")).mockResolvedValue({})
  spyOn(skillLoader, unsafeTestValue("loadOpencodeProjectSkills")).mockResolvedValue({})
  spyOn(skillLoader, unsafeTestValue("discoverUserClaudeSkills")).mockResolvedValue([])
  spyOn(skillLoader, unsafeTestValue("discoverProjectClaudeSkills")).mockResolvedValue([])
  spyOn(skillLoader, unsafeTestValue("discoverOpencodeGlobalSkills")).mockResolvedValue([])
  spyOn(skillLoader, unsafeTestValue("discoverOpencodeProjectSkills")).mockResolvedValue([])
  spyOn(agentLoader, unsafeTestValue("loadUserAgents")).mockReturnValue({})
  spyOn(agentLoader, unsafeTestValue("loadProjectAgents")).mockReturnValue({})
  spyOn(agentLoader, unsafeTestValue("loadOpencodeGlobalAgents")).mockReturnValue({})
  spyOn(agentLoader, unsafeTestValue("loadOpencodeProjectAgents")).mockReturnValue({})
  spyOn(mcpLoader, unsafeTestValue("loadMcpConfigs")).mockResolvedValue({ servers: {}, loadedServers: [] })
  spyOn(mcpLoader, "setAdditionalAllowedMcpEnvVars").mockImplementation(() => {})
  spyOn(pluginLoader, unsafeTestValue("loadAllPluginComponents")).mockResolvedValue({
    commands: {},
    skills: {},
    agents: {},
    mcpServers: {},
    hooksConfigs: [],
    plugins: [],
    errors: [],
  })
  spyOn(mcpModule, unsafeTestValue("createBuiltinMcps")).mockReturnValue({})
  spyOn(shared, unsafeTestValue("log")).mockImplementation(() => {})
  spyOn(shared, unsafeTestValue("fetchAvailableModels")).mockResolvedValue(new Set(["onara/oracle"]))
  spyOn(shared, unsafeTestValue("readConnectedProvidersCache")).mockReturnValue(null)
  spyOn(configDir, unsafeTestValue("getOpenCodeConfigPaths")).mockReturnValue({
    configDir: "/tmp/.config/opencode",
    configJson: "/tmp/.config/opencode/opencode.json",
    configJsonc: "/tmp/.config/opencode/opencode.jsonc",
    packageJson: "/tmp/.config/opencode/package.json",
    omoConfig: "/tmp/.config/opencode/omo.jsonc",
  })
  spyOn(permissionCompat, unsafeTestValue("migrateAgentConfig")).mockImplementation(
    (config: Record<string, unknown>) => config,
  )
  spyOn(modelResolver, unsafeTestValue("resolveModelWithFallback")).mockReturnValue({
    model: "onara/oracle",
    source: "provider-fallback",
  })
  ;({ createConfigHandler } = await importFreshConfigHandlerModule())
})

afterEach(() => {
  setAgentSortOrder(undefined)
  configErrors.clearConfigLoadErrors()
  mock.restore()
})

/** Drive one request through the observer exactly as the config hook installs it. */
async function driveTurn(servedBy: string, model: string): Promise<void> {
  const config: Record<string, unknown> = {
    provider: {
      onara: {
        options: {
          fetch: async () => new Response("{}", { headers: { "X-9Router-Upstream-Model": servedBy } }),
        },
      },
    },
  }
  installUpstreamModelObserver(config)
  const providers = config.provider as Record<string, { options: Record<string, unknown> }>
  const wrapped = providers.onara?.options.fetch as (input: unknown, init?: unknown) => Promise<Response>
  await wrapped("https://router.example/v1/chat/completions", {
    body: JSON.stringify({ model, messages: [] }),
  })
}

function makeHandler() {
  return createConfigHandler({
    ctx: { directory: "/tmp" },
    pluginConfig: createPluginConfig(),
    modelCacheState: {
      anthropicContext1MEnabled: false,
      modelContextLimitsCache: new Map(),
    },
  })
}

describe("upstream model detection", () => {
  describe("#given the agent roster was built while an alias was still opaque", () => {
    test("#when a response reveals the real vendor #then the roster is rebuilt rather than replayed from cache", async () => {
      // The crux. Agent prompts and reasoning effort are baked into a roster that is
      // cached at config time. If the cache key ignores what a response taught us,
      // the stale roster is replayed and the observation never reaches an agent.
      const handler = makeHandler()
      const hookConfig = () => ({ model: "onara/oracle", agent: {} })

      await handler(hookConfig())
      const buildsBefore = unsafeTestValue(agents.createBuiltinAgents).mock.calls.length

      // Repeating an unchanged config must still hit the cache - no regression.
      await handler(hookConfig())
      expect(unsafeTestValue(agents.createBuiltinAgents).mock.calls).toHaveLength(buildsBefore)

      await driveTurn("openai/gpt-5.6-sol", "oracle")
      await handler(hookConfig())

      expect(unsafeTestValue(agents.createBuiltinAgents).mock.calls.length).toBeGreaterThan(buildsBefore)
    })
  })

  describe("#given nothing new was observed", () => {
    test("#when the config hook runs repeatedly #then the cached roster is reused", async () => {
      const handler = makeHandler()

      await handler({ model: "onara/oracle", agent: {} })
      await handler({ model: "onara/oracle", agent: {} })
      await handler({ model: "onara/oracle", agent: {} })

      expect(unsafeTestValue(agents.createBuiltinAgents).mock.calls).toHaveLength(1)
    })
  })

  describe("#given the observed vendor", () => {
    test("#when an agent is constructed afterwards #then it carries that vendor's shape", async () => {
      expect(isGptModel("onara/momus")).toBe(false)
      const before = createOracleAgent("onara/momus")

      await driveTurn("openai/gpt-5.6-sol", "momus")

      const after = createOracleAgent("onara/momus")
      expect(isGptModel("onara/momus")).toBe(true)
      expect(after.reasoningEffort).toBe("xhigh")
      expect(after.prompt).not.toBe(before.prompt)
    })

    test("#when a later turn falls back to another vendor #then the shape follows it", async () => {
      await driveTurn("openai/gpt-5.6-sol", "oracle")
      expect(createOracleAgent("onara/oracle").reasoningEffort).toBe("xhigh")

      await driveTurn("anthropic/claude-opus-5", "oracle")

      expect(isGptModel("onara/oracle")).toBe(false)
      expect(createOracleAgent("onara/oracle").reasoningEffort).toBeUndefined()
    })
  })

  describe("#given no turn has completed", () => {
    test("#then behavior is unchanged from before this feature", () => {
      expect(isGptModel("onara/oracle")).toBe(false)
      expect(createOracleAgent("onara/oracle").reasoningEffort).toBeUndefined()
    })
  })
})
