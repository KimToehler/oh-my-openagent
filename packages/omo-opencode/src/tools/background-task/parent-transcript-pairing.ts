import type { BackgroundOutputClient, BackgroundOutputMessage } from "./clients"
import { extractMessages, getErrorMessage } from "./session-messages"
import { getBackgroundOutputFetchTimeoutMs, withSdkCallTimeout } from "./with-sdk-call-timeout"

const SESSION_ID_PATTERN = "ses[_-][A-Za-z0-9_-]+"

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
        if (block.text) {
          chunks.push(block.text)
        }
      }
    }
  }
  return chunks
}

function findPairingInMetadataBlocks(chunk: string, taskId: string): string | undefined {
  const blocks = [...chunk.matchAll(/<task_metadata>([\s\S]*?)<\/task_metadata>/gi)]
  for (const block of blocks) {
    const content = block[1] ?? ""
    const backgroundTaskId = content.match(/background_task_id:\s*(\S+)/)?.[1]
    if (backgroundTaskId !== taskId) {
      continue
    }
    const sessionId = content.match(new RegExp(`session_id:\\s*(${SESSION_ID_PATTERN})`))?.[1]
    if (sessionId) {
      return sessionId
    }
  }
  return undefined
}

function findPairingInSummaryLine(chunk: string, taskId: string): string | undefined {
  const escapedTaskId = escapeRegExp(taskId)
  const summaryLine = new RegExp(`\`${escapedTaskId}\`[^\\n]*\\| session: \`(${SESSION_ID_PATTERN})\``)
  return chunk.match(summaryLine)?.[1]
}

function findPairingInLaunchOutput(chunk: string, taskId: string): string | undefined {
  const escapedTaskId = escapeRegExp(taskId)
  const mentionsTask = new RegExp(`Task ID:\\s*\`?${escapedTaskId}\`?(?![A-Za-z0-9_-])`)
  if (!mentionsTask.test(chunk)) {
    return undefined
  }
  return chunk.match(new RegExp(`Session ID:\\s*\`?(${SESSION_ID_PATTERN})`))?.[1]
}

function findPairingInChunk(chunk: string, taskId: string): string | undefined {
  if (!chunk.includes(taskId)) {
    return undefined
  }
  return (
    findPairingInMetadataBlocks(chunk, taskId)
    ?? findPairingInSummaryLine(chunk, taskId)
    ?? findPairingInLaunchOutput(chunk, taskId)
  )
}

/**
 * Scans the CALLING session's transcript for a `bg_... → ses_...` pairing that
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
  } catch {
    return undefined
  }

  if (getErrorMessage(messagesResult)) {
    return undefined
  }

  const messages = extractMessages(messagesResult)
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const chunk of collectTextChunks(messages[i]!)) {
      const sessionId = findPairingInChunk(chunk, taskId)
      if (sessionId) {
        return sessionId
      }
    }
  }

  return undefined
}
