import type { PluginInput } from "@opencode-ai/plugin"
import type { ExperimentalConfig } from "../config/schema"
import { createDynamicTruncator } from "../shared/dynamic-truncator"
import { applyToolOutputText, resolveToolOutputText } from "../shared/tool-output-text"

const DEFAULT_MAX_TOKENS = 50_000 // ~200k chars
const WEBFETCH_MAX_TOKENS = 10_000 // ~40k chars - web pages need aggressive truncation

const TRUNCATABLE_TOOLS = [
  "grep",
  "Grep",
  "safe_grep",
  "glob",
  "Glob",
  "safe_glob",
  "lsp_diagnostics",
  "interactive_bash",
  "Interactive_bash",
  "skill_mcp",
  "webfetch",
  "WebFetch",
]

const TOOL_SPECIFIC_MAX_TOKENS: Record<string, number> = {
  webfetch: WEBFETCH_MAX_TOKENS,
  WebFetch: WEBFETCH_MAX_TOKENS,
}

interface ToolOutputTruncatorOptions {
  modelCacheState?: {
    anthropicContext1MEnabled: boolean
    modelContextLimitsCache?: Map<string, number>
  }
  experimental?: ExperimentalConfig
}

export function createToolOutputTruncatorHook(ctx: PluginInput, options?: ToolOutputTruncatorOptions) {
  const truncator = createDynamicTruncator(ctx, options?.modelCacheState)
  const truncateAll = options?.experimental?.truncate_all_tool_outputs ?? false

  const toolExecuteAfter = async (
    input: { tool: string; sessionID: string; callID: string },
    output: { title: string; output?: unknown; metadata: unknown; content?: unknown }
  ) => {
    if (!truncateAll && !TRUNCATABLE_TOOLS.includes(input.tool)) return

    const outputText = resolveToolOutputText(output)
    if (outputText === undefined) return

    try {
      const targetMaxTokens = TOOL_SPECIFIC_MAX_TOKENS[input.tool] ?? DEFAULT_MAX_TOKENS
      const { result, truncated } = await truncator.truncate(
        input.sessionID,
        outputText,
        { targetMaxTokens }
      )
      if (truncated) {
        applyToolOutputText(output, result)
      }
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error
      }
    }
  }

  return {
    "tool.execute.after": toolExecuteAfter,
  }
}
