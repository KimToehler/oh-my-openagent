import { matchesTrackedTool } from "../../shared/tool-name-match"

const WRITE_EDIT_TOOL_NAMES = ["write", "edit", "hashline_edit"] as const

export function isWriteOrEditToolName(toolName: string): boolean {
  return matchesTrackedTool(toolName, WRITE_EDIT_TOOL_NAMES)
}
