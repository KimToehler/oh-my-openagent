import type { OhMyOpenCodeConfig } from "../config";
import { applyRuntimeSkillSourceConfig } from "../features/opencode-runtime-skills"
import { setAdditionalAllowedMcpEnvVars } from "../features/claude-code-mcp-loader";
import type { ModelCacheState } from "../plugin-state";
import { log } from "../shared";
import { applyAgentConfig } from "./agent-config-handler";
import { applyCommandConfig } from "./command-config-handler";
import { applyHookConfig } from "./hook-config-handler";
import { applyMcpConfig } from "./mcp-config-handler";
import { applyProviderConfig } from "./provider-config-handler";
import { loadPluginComponents } from "./plugin-components-loader";
import { applyToolConfig } from "./tool-config-handler";
import { installUpstreamModelObserver } from "./upstream-model-observer";
import { resolveModelForFamilyDetection } from "@oh-my-opencode/model-core";
import { clearFormatterCache } from "../tools/hashline-edit/formatter-trigger"
import {
  clearRegisteredAgentNames,
  registerAgentName,
} from "../features/claude-code-session-state";
import { setDefaultAgentForSort } from "../shared/agent-sort-shim";
import { getConfiguredDefaultAgent } from "./agent-config-assembly";

export { resolveCategoryConfig } from "./category-config-resolver";

function collectTrustedVisionCapableModels(
  pluginConfig: OhMyOpenCodeConfig,
): string[] {
  const trusted: string[] = []
  const multimodalLookerOverride = pluginConfig.agents?.["multimodal-looker"]
  const configuredModel = multimodalLookerOverride?.model
  if (typeof configuredModel === "string" && configuredModel.includes("/")) {
    trusted.push(configuredModel)
  }
  return trusted
}

export interface ConfigHandlerDeps {
  ctx: { directory: string; client?: unknown };
  pluginConfig: OhMyOpenCodeConfig;
  modelCacheState: ModelCacheState;
  runtimeSkillSourceUrl?: string;
}

type AgentConfigSnapshot = {
  readonly cacheKey: string;
  readonly configuredDefaultAgent: string | undefined;
  readonly defaultAgent: unknown;
  readonly agents: Record<string, unknown>;
}

function cloneConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneConfigValue)
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneConfigValue(entry)]),
    )
  }

  return value
}

function cloneAgentConfig(agents: Record<string, unknown>): Record<string, unknown> {
  return cloneConfigValue(agents) as Record<string, unknown>
}

/**
 * Model ids whose family may have been learned from a response, in the form the
 * detectors will see.
 *
 * Agent prompts, reasoning effort, and tool restrictions are baked into the cached
 * roster at build time. A proxy alias resolves to its real vendor only after a
 * response reports one, so unless that resolution is part of the key, the first
 * roster - built while the alias was still opaque - is replayed forever and the
 * observation never reaches an agent.
 */
function collectResolvedModelIdentity(config: Record<string, unknown>): Record<string, string> {
  const identity: Record<string, string> = {}

  const record = (model: unknown): void => {
    if (typeof model !== "string" || model === "") return
    const resolved = resolveModelForFamilyDetection(model)
    if (resolved !== model) identity[model] = resolved
  }

  record(config.model)
  const agents = config.agent
  if (agents !== null && typeof agents === "object") {
    for (const agent of Object.values(agents as Record<string, unknown>)) {
      if (agent !== null && typeof agent === "object") record((agent as { model?: unknown }).model)
    }
  }

  return identity
}

function createAgentConfigCacheKey(config: Record<string, unknown>): string {
  return JSON.stringify({
    agent: config.agent,
    default_agent: config.default_agent,
    model: config.model,
    skills: config.skills,
    // Changes when a response teaches us the real vendor behind an alias, so the
    // roster is rebuilt with the correct prompt instead of replaying the stale one.
    resolvedModels: collectResolvedModelIdentity(config),
  })
}

function replayAgentConfigSideEffects(params: {
  agentResult: Record<string, unknown>;
  configuredDefaultAgent: string | undefined;
  defaultAgent: unknown;
}): void {
  if (params.configuredDefaultAgent && typeof params.defaultAgent === "string") {
    setDefaultAgentForSort(params.defaultAgent)
  }
  clearRegisteredAgentNames()
  for (const name of Object.keys(params.agentResult)) {
    registerAgentName(name)
  }
}

export function createConfigHandler(deps: ConfigHandlerDeps) {
  const { ctx, pluginConfig, modelCacheState, runtimeSkillSourceUrl } = deps;
  let agentConfigSnapshot: AgentConfigSnapshot | undefined;

  return async (config: Record<string, unknown>) => {
    const formatterConfig = config.formatter;

    setAdditionalAllowedMcpEnvVars(pluginConfig.mcp_env_allowlist ?? [])
    // Wrap each provider's fetch so the model that actually served a response is
    // recorded. This is the only supported way to observe a successful response:
    // no plugin hook exposes one. See upstream-model-observer.ts.
    installUpstreamModelObserver(config)
    applyProviderConfig({
      config,
      modelCacheState,
      trustedVisionCapableModels: collectTrustedVisionCapableModels(pluginConfig),
    });
    clearFormatterCache()

    const pluginComponents = await loadPluginComponents({ pluginConfig });
    const pluginComponentsLoadFailed = pluginComponents.retryableLoadFailure === true;

    applyHookConfig({ pluginComponents });

    const agentCacheKey = createAgentConfigCacheKey(config);
    let agentResult: Record<string, unknown>;
    if (!pluginComponentsLoadFailed && agentConfigSnapshot?.cacheKey === agentCacheKey) {
      config.agent = cloneAgentConfig(agentConfigSnapshot.agents);
      if (agentConfigSnapshot.defaultAgent !== undefined) {
        config.default_agent = agentConfigSnapshot.defaultAgent;
      }
      agentResult = config.agent as Record<string, unknown>;
      replayAgentConfigSideEffects({
        agentResult,
        configuredDefaultAgent: agentConfigSnapshot.configuredDefaultAgent,
        defaultAgent: config.default_agent,
      })
    } else {
      const configuredDefaultAgent = getConfiguredDefaultAgent(config);
      agentResult = await applyAgentConfig({
        config,
        pluginConfig,
        ctx,
        pluginComponents,
      });
      agentConfigSnapshot = pluginComponentsLoadFailed
        ? undefined
        : {
            cacheKey: agentCacheKey,
            configuredDefaultAgent,
            defaultAgent: config.default_agent,
            agents: cloneAgentConfig(agentResult),
          };
    }

    applyToolConfig({ config, pluginConfig, agentResult });
    await applyMcpConfig({ config, pluginConfig, ctx, pluginComponents });
    await applyCommandConfig({ config, pluginConfig, ctx, pluginComponents });
    if (runtimeSkillSourceUrl) {
      applyRuntimeSkillSourceConfig({
        config,
        pluginConfig,
        sourceUrl: runtimeSkillSourceUrl,
      })
    }

    config.formatter = formatterConfig;

    log("[config-handler] config handler applied", {
      agentCount: Object.keys(agentResult).length,
      commandCount: Object.keys((config.command as Record<string, unknown>) ?? {})
        .length,
    });
  };
}
