import { join } from "node:path"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { log, messagesInDirectory, normalizeSDKResponse } from "../../shared"
import { resolveRegisteredAgentName } from "../claude-code-session-state"
import { MESSAGE_STORAGE } from "../hook-message-injector"
import {
  findNearestMessageExcludingCompaction,
  resolvePromptContextFromSessionMessages,
} from "./compaction-aware-message-resolver"

export type AdoptedSessionIdentity = {
  readonly agent?: string
  readonly model?: { providerID: string; modelID: string; variant?: string }
}

type IdentityMessage = {
  info?: {
    agent?: string
    model?: { providerID?: string; modelID?: string; variant?: string }
    providerID?: string
    modelID?: string
  }
  parts?: Array<{ type?: string }>
}

function toIdentity(context: { agent?: string; model?: { providerID?: string; modelID?: string; variant?: string } } | null): AdoptedSessionIdentity {
  if (!context) {
    return {}
  }

  // The transcript carries the agent's display name, while dispatch and tool
  // restrictions key off the registered config name. Resolve the drift here so
  // adoption cannot hand a display-only name to the prompt body.
  const agent = resolveRegisteredAgentName(context.agent) ?? context.agent
  const model = context.model?.providerID && context.model.modelID
    ? {
        providerID: context.model.providerID,
        modelID: context.model.modelID,
        ...(context.model.variant ? { variant: context.model.variant } : {}),
      }
    : undefined

  return {
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
  }
}

/**
 * Recover the agent and model an orphaned session actually ran under.
 *
 * Adoption previously invented an agent name, producing a task that could never
 * dispatch. The server transcript is the only source that survives both a plugin
 * restart and completed-task cleanup, so it is the source of truth here; the
 * in-memory session-agent map is cleared on exactly those paths.
 *
 * Returns an empty identity when nothing is recoverable. Callers MUST treat that
 * as a refusal to adopt rather than substituting a placeholder agent.
 */
export async function resolveAdoptedSessionIdentity(
  client: OpencodeClient,
  sessionID: string,
  directory: string,
): Promise<AdoptedSessionIdentity> {
  try {
    const response = await messagesInDirectory(client, { path: { id: sessionID } }, directory)
    const messages = normalizeSDKResponse(response, [] as IdentityMessage[], {
      preferResponseOnMissingData: true,
    })

    const identity = toIdentity(resolvePromptContextFromSessionMessages(messages, sessionID))
    if (identity.agent) {
      return identity
    }

    const stored = toIdentity(findNearestMessageExcludingCompaction(join(MESSAGE_STORAGE, sessionID), sessionID))
    return stored.agent ? stored : identity
  } catch (error) {
    log("[background-agent] Failed to resolve adopted session identity from server; trying stored transcript", {
      sessionID,
      error: String(error),
    })

    return toIdentity(findNearestMessageExcludingCompaction(join(MESSAGE_STORAGE, sessionID), sessionID))
  }
}
