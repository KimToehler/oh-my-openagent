/**
 * Reads the textual result of a tool call out of a `tool.execute.after` payload.
 *
 * Native and MCP tools arrive in DIFFERENT shapes, because OpenCode fires the hook at a
 * different point in each path (verified against the OpenCode 1.18.15 bundle):
 *
 * - native: `{...toolResult, attachments}` is passed, so `.output` is already a string.
 * - MCP: the RAW MCP result is passed, whose text lives in `content[]` blocks. The
 *   normalized `.output` string is built on the NEXT line, after every plugin hook has
 *   already run, so reading `.output` here yields `undefined` for every MCP tool.
 *
 * Guarding on `typeof output.output === "string"` therefore silently drops 100% of MCP
 * tool calls. That is what disarmed the detached-shell-job guard: jobs never registered,
 * and terminal status polls could not clear them.
 */

type ToolOutputTextSource = {
  readonly output?: unknown
  readonly content?: unknown
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  if (typeof block !== "object" || block === null) return false
  const candidate = block as { type?: unknown; text?: unknown }
  return candidate.type === "text" && typeof candidate.text === "string"
}

export function resolveToolOutputText(output: ToolOutputTextSource | undefined): string | undefined {
  if (output === undefined) return undefined

  if (typeof output.output === "string") return output.output

  if (!Array.isArray(output.content)) return undefined

  const text = output.content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("\n")

  return text.length === 0 ? undefined : text
}
