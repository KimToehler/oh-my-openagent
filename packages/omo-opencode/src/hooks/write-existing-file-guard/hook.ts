import type { Hooks, PluginInput } from "@opencode-ai/plugin"

import { resolve } from "path"

import { handleWriteExistingFileGuardToolExecuteBefore } from "./tool-execute-before-handler"
import { resolveSessionEventID } from "../../shared/event-session-id"
import {
  isPathInsideDirectory,
  resolveInputPath as resolveContainedInputPath,
  toCanonicalPath,
} from "../../shared/path-containment"

export { isPathInsideDirectory, toCanonicalPath }

export type GuardArgs = {
  filePath?: string
  path?: string
  file_path?: string
  overwrite?: boolean | string
}

const MAX_TRACKED_SESSIONS = 256
export const MAX_TRACKED_PATHS_PER_SESSION = 1024

type WriteExistingFileGuardOptions = {
  maxTrackedSessions?: number
  maxTrackedPathsPerSession?: number
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  return value as Record<string, unknown>
}

export function getPathFromArgs(args: GuardArgs | undefined): string | undefined {
  return args?.filePath ?? args?.path ?? args?.file_path
}

export function resolveInputPath(ctx: PluginInput, inputPath: string): string {
  return resolveContainedInputPath(ctx.directory, inputPath)
}

export function isOverwriteEnabled(value: boolean | string | undefined): boolean {
  if (value === true) {
    return true
  }

  if (typeof value === "string") {
    return value.toLowerCase() === "true"
  }

  return false
}

export function createWriteExistingFileGuardHook(ctx: PluginInput, options?: WriteExistingFileGuardOptions): Hooks {
  const readPermissionsBySession = new Map<string, Set<string>>()
  const sessionLastAccess = new Map<string, number>()
  const maxTrackedSessions = options?.maxTrackedSessions ?? MAX_TRACKED_SESSIONS
  const maxTrackedPathsPerSession = options?.maxTrackedPathsPerSession ?? MAX_TRACKED_PATHS_PER_SESSION
  let canonicalSessionRoot: string | undefined

  function getCanonicalSessionRoot(): string {
    if (!canonicalSessionRoot) {
      canonicalSessionRoot = toCanonicalPath(resolveInputPath(ctx, ctx.directory))
    }

    return canonicalSessionRoot
  }

  return {
    "tool.execute.before": async (input, output) => {
      await handleWriteExistingFileGuardToolExecuteBefore({
        ctx,
        input,
        output,
        readPermissionsBySession,
        sessionLastAccess,
        getCanonicalSessionRoot,
        maxTrackedSessions,
        maxTrackedPathsPerSession,
      })
    },
    event: async ({ event }: { event: { type: string; properties?: unknown } }) => {
      if (event.type !== "session.deleted") {
        return
      }

      const sessionID = resolveSessionEventID(event.properties)
      if (!sessionID) {
        return
      }

      readPermissionsBySession.delete(sessionID)
      sessionLastAccess.delete(sessionID)
    },
  }
}
