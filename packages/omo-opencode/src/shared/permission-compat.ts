/**
 * Permission system utilities for OpenCode 1.1.1+.
 * This module only supports the new permission format.
 */

export type PermissionValue = "ask" | "allow" | "deny"

export interface PermissionFormat {
  permission: Record<string, PermissionValue>
}

/**
 * Read-only filesystem tools every research agent needs to do its job.
 *
 * These must be granted EXPLICITLY rather than left to default, because a user
 * config may carry a global `permission` deny (e.g. `{"read":"deny","grep":"deny",
 * "glob":"deny","bash":"deny"}`, which the lean-ctx installer writes to force the
 * primary agent through its `ctx_*` MCP tools). A global deny applies to every
 * agent, and subagents have no MCP tools attached to fall back on — so without an
 * explicit allow, a research agent is left with no way to read a file at all.
 *
 * The failure is silent and looks like a model defect: the agent still runs, still
 * reasons, and reports "blocked on tooling" or invents nothing — but every lane
 * returns empty. Agent-level `allow` beats global `deny`, so listing them here is
 * what keeps these agents functional under a restrictive user config.
 */
export const READ_ONLY_FILE_TOOLS = ["read", "grep", "glob"] as const

/**
 * Creates tool restrictions that deny specified tools.
 */
export function createAgentToolRestrictions(
  denyTools: string[],
  allowTools: string[] = [],
): PermissionFormat {
  return {
    permission: Object.fromEntries([
      ...denyTools.map((tool) => [tool, "deny" as const]),
      ...allowTools.map((tool) => [tool, "allow" as const]),
    ]),
  }
}

/**
 * Creates tool restrictions that ONLY allow specified tools.
 * All other tools are denied by default using `*: deny` pattern.
 */
export function createAgentToolAllowlist(
  allowTools: string[]
): PermissionFormat {
  return {
    permission: {
      "*": "deny" as const,
      ...Object.fromEntries(
        allowTools.map((tool) => [tool, "allow" as const])
      ),
    },
  }
}

/**
 * Converts legacy tools format to permission format.
 * For migrating user configs from older versions.
 */
export function migrateToolsToPermission(
  tools: Record<string, boolean>
): Record<string, PermissionValue> {
  return Object.fromEntries(
    Object.entries(tools).map(([key, value]) => [
      key,
      value ? ("allow" as const) : ("deny" as const),
    ])
  )
}

/**
 * Migrates agent config from legacy tools format to permission format.
 * If config has `tools`, converts to `permission`.
 */
export function migrateAgentConfig(
  config: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...config }

  if (result.tools && typeof result.tools === "object") {
    const existingPermission =
      (result.permission as Record<string, PermissionValue>) || {}
    const migratedPermission = migrateToolsToPermission(
      result.tools as Record<string, boolean>
    )
    result.permission = { ...migratedPermission, ...existingPermission }
    delete result.tools
  }

  if (result.permission && typeof result.permission === "object") {
    const perm = { ...(result.permission as Record<string, PermissionValue>) }
    if ("delegate_task" in perm && !("task" in perm)) {
      perm["task"] = perm["delegate_task"]
      delete perm["delegate_task"]
      result.permission = perm
    }
  }

  return result
}
