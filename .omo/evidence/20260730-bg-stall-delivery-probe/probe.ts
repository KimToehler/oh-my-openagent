#!/usr/bin/env bun
import { pruneStaleTasksAndNotifications } from "../../../packages/omo-opencode/src/features/background-agent/task-poller"
import { ParentWakeNotifier } from "../../../packages/omo-opencode/src/features/background-agent/parent-wake-notifier"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { releaseAllPromptAsyncReservationsForTesting } from "../../../packages/omo-opencode/src/hooks/shared/prompt-async-gate"

const now = Date.now()
const staleTask = {
  id: "stalled-1", parentSessionId: "parent-1", parentMessageId: "msg-1", description: "silent stream", prompt: "hang", agent: "explore", status: "running" as const, startedAt: new Date(now - 91_000), progress: { toolCalls: 0, lastUpdate: new Date(now - 91_000) }, sessionId: "child-1",
}
const busyPruned: string[] = []
pruneStaleTasksAndNotifications({ tasks: new Map([[staleTask.id, { ...staleTask }]]), notifications: new Map(), taskTtlMs: 90_000, sessionStatuses: { "child-1": { type: "busy" } }, onTaskPruned: (id) => busyPruned.push(id) })
const idlePruned: string[] = []
pruneStaleTasksAndNotifications({ tasks: new Map([[staleTask.id, { ...staleTask }]]), notifications: new Map(), taskTtlMs: 90_000, sessionStatuses: { "child-1": { type: "idle" } }, onTaskPruned: (id) => idlePruned.push(id) })

const calls: unknown[] = []
const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:1" })
Object.assign(client.session, {
  status: async () => ({ data: { "parent-1": { type: "idle" } } }),
  messages: async () => ({ data: [{ info: { role: "user", time: { created: now - 120_000 } }, parts: [{ type: "text", text: "done" }] }, { info: { role: "assistant", finish: "stop", time: { created: now - 110_000 } }, parts: [{ type: "text", text: "safe" }] }] }),
  promptAsync: async (input: unknown) => { calls.push(input); return { data: {} } },
  abort: async () => ({ data: {} }),
})
const notifier = new ParentWakeNotifier({ client, directory: process.cwd(), enqueueNotificationForParent: async (_id, operation) => operation() }, { pendingRetryMs: 10, acceptedMessageSkewMs: 5_000, toolCallDeferMaxMs: 5_000, failureRequeueWindowMs: 5_000, userMessageInProgressWindowMs: 2_000 })
const notification = "<system-reminder>\n[BACKGROUND TASK ERROR]\n\nstalled task\n</system-reminder>"
notifier.queuePendingParentWake("parent-1", notification, { agent: "sisyphus" }, true, 1)
await notifier.flushPendingParentWake("parent-1")
console.log(JSON.stringify({ timestamp: new Date().toISOString(), ttlMs: 90_000, busyPruned, idlePruned, promptAsyncCallCount: calls.length, injectedParts: calls.length > 0 }, null, 2))
notifier.shutdown()
releaseAllPromptAsyncReservationsForTesting()
