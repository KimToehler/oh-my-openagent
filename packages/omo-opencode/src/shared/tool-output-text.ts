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

type ToolOutputTextTarget = {
  output?: unknown
  content?: unknown
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

/**
 * Writes replacement text back into a `tool.execute.after` payload.
 *
 * The write path is asymmetric for the same reason the read path is. For native tools
 * OpenCode passes `{...toolResult, attachments}` and returns that very object, so
 * assigning `.output` propagates. For MCP tools the RAW result is passed and the returned
 * object is rebuilt as `{output: <joined content[] text>, content: m.content}` AFTER every
 * plugin hook has run, so assigning `.output` is discarded and only a `content[]` edit
 * survives.
 *
 * Mirrors `resolveToolOutputText`: native `.output` wins when both shapes are present, and
 * the MCP branch collapses into the FIRST text block (the rest are emptied) because the
 * text is rejoined with newlines downstream.
 *
 * Returns whether a writable target was found.
 */
export function applyToolOutputText(
  output: ToolOutputTextTarget | undefined,
  text: string
): boolean {
  if (output === undefined) return false

  if (typeof output.output === "string") {
    output.output = text
    return true
  }

  if (!Array.isArray(output.content)) return false

  const textBlockIndexes = output.content.flatMap((block, index) => (isTextBlock(block) ? [index] : []))
  const firstTextBlockIndex = textBlockIndexes[0]
  if (firstTextBlockIndex === undefined) return false

  for (const index of textBlockIndexes) {
    const block = output.content[index] as { type: "text"; text: string }
    block.text = index === firstTextBlockIndex ? text : ""
  }

  return true
}
