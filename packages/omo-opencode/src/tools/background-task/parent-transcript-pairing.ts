import { log } from "../../shared/logger"
import type { BackgroundOutputClient, BackgroundOutputMessage } from "./clients"
import { extractMessages, getErrorMessage } from "./session-messages"
import { getBackgroundOutputFetchTimeoutMs, withSdkCallTimeout } from "./with-sdk-call-timeout"

const SESSION_ID_PATTERN = "ses[_-][A-Za-z0-9_-]+"

// ReDoS bounds: the scanned text is attacker-influenceable transcript content,
// so every regex here runs over bounded input with bounded quantifiers.
const MAX_CHUNK_LENGTH = 64 * 1024
const MAX_MESSAGES_SCANNED = 200
const MAX_METADATA_BLOCK_LENGTH = 8192

// Anchors every `Task ID:` mention and captures the exact bg id it names, so
// the session lookup can be positionally scoped to the matching launch record.
const TASK_ID_ANCHOR = /Task ID:\s{0,16}`?(bg[_-][A-Za-z0-9_-]+)`?/g
const SESSION_ID_AFTER_LABEL = new RegExp(`Session ID:\\s{0,16}\`?(${SESSION_ID_PATTERN})`)
const METADATA_BLOCK = new RegExp(`<task_metadata>([\\s\\S]{0,${MAX_METADATA_BLOCK_LENGTH}}?)</task_metadata>`, "gi")
const METADATA_SESSION_ID = new RegExp(`session_id:\\s{0,16}(${SESSION_ID_PATTERN})`)

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function collectTextChunks(message: BackgroundOutputMessage): string[] {
  const chunks: string[] = []
  for (const part of message.parts ?? []) {
    if (typeof part.text === "string" && part.text.length > 0) {
      chunks.push(part.text)
    }
    if (typeof part.output === "string" && part.output.length > 0) {
      chunks.push(part.output)
    }
    if (typeof part.content === "string" && part.content.length > 0) {
      chunks.push(part.content)
    } else if (Array.isArray(part.content)) {
      for (const block of part.content) {
        if (typeof block.text === "string" && block.text.length > 0) {
          chunks.push(block.text)
        }
      }
    }
  }
  return chunks
}

function findPairingInMetadataBlocks(chunk: string, taskId: string): string | undefined {
  const blocks = [...chunk.matchAll(METADATA_BLOCK)]
  for (const block of blocks) {
    const content = block[1] ?? ""
    const backgroundTaskId = content.match(/background_task_id:\s{0,16}(\S+)/)?.[1]
    if (backgroundTaskId !== taskId) {
      continue
    }
    const sessionId = content.match(METADATA_SESSION_ID)?.[1]
    if (sessionId) {
      return sessionId
    }
  }
  return undefined
}

function findPairingInLaunchOutput(chunk: string, taskId: string): string | undefined {
  // Positional anchoring: locate the launch record whose captured id EQUALS the
  // requested taskId, then look for `Session ID:` only in the slice between that
  // record and the next one. A chunk can inline several launch records (nested
  // tool_result content, batch summaries), so an unscoped session search would
  // return another task's session, a silently wrong answer.
  const anchors = [...chunk.matchAll(TASK_ID_ANCHOR)]
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i]!
    if (anchor[1] !== taskId) {
      continue
    }
    const start = (anchor.index ?? 0) + anchor[0].length
    const nextAnchor = anchors[i + 1]
    const end = nextAnchor?.index ?? chunk.length
    const sessionId = chunk.slice(start, end).match(SESSION_ID_AFTER_LABEL)?.[1]
    if (sessionId) {
      return sessionId
    }
  }
  return undefined
}

interface PairingMatchers {
  taskId: string
  summaryLine: RegExp
}

function createPairingMatchers(taskId: string): PairingMatchers {
  const escapedTaskId = escapeRegExp(taskId)
  return {
    taskId,
    summaryLine: new RegExp(`\`${escapedTaskId}\`[^\\n]{0,512}\\| session: \`(${SESSION_ID_PATTERN})\``),
  }
}

function findPairingInChunk(rawChunk: string, matchers: PairingMatchers): string | undefined {
  const chunk = rawChunk.slice(0, MAX_CHUNK_LENGTH)
  // Fast reject only: every matcher below independently correlates the exact
  // task id with its session id, so this check can never create a pairing.
  if (!chunk.includes(matchers.taskId)) {
    return undefined
  }
  return (
    findPairingInMetadataBlocks(chunk, matchers.taskId)
    ?? chunk.match(matchers.summaryLine)?.[1]
    ?? findPairingInLaunchOutput(chunk, matchers.taskId)
  )
}

/**
 * Scans the CALLING session's transcript for a `bg_... -> ses_...` pairing that
 * the launch output and the completion notification both record. This works
 * across a process/realm split because it reads server/DB-backed session state,
 * not this runtime's memory. Later messages win: the completion notification is
 * more authoritative than the launch output.
 */
export async function findSessionIdInParentTranscript(
  client: BackgroundOutputClient,
  parentSessionId: string,
  taskId: string,
): Promise<string | undefined> {
  let messagesResult: Awaited<ReturnType<BackgroundOutputClient["session"]["messages"]>>
  try {
    messagesResult = await withSdkCallTimeout(
      client.session.messages({ path: { id: parentSessionId } }),
      getBackgroundOutputFetchTimeoutMs(),
    )
  } catch (error) {
    log("[background_output] parent transcript fetch failed during cross-runtime recovery", {
      taskId,
      parentSessionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }

  const errorMessage = getErrorMessage(messagesResult)
  if (errorMessage) {
    log("[background_output] parent transcript returned an error during cross-runtime recovery", {
      taskId,
      parentSessionId,
      error: errorMessage,
    })
    return undefined
  }

  const matchers = createPairingMatchers(taskId)
  const messages = extractMessages(messagesResult)
  const oldestIndex = Math.max(0, messages.length - MAX_MESSAGES_SCANNED)
  for (let i = messages.length - 1; i >= oldestIndex; i--) {
    for (const chunk of collectTextChunks(messages[i]!)) {
      const sessionId = findPairingInChunk(chunk, matchers)
      if (sessionId) {
        return sessionId
      }
    }
  }

  return undefined
}
