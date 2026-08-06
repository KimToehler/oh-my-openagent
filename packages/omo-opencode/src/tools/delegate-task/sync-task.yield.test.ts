/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { handedBackSyncSessions, subagentSessions, _resetForTesting } from "../../features/claude-code-session-state"
import { executeSyncTask } from "./sync-task"
import type { SyncTaskDeps } from "./sync-task-deps"
import type { ExecutorContext } from "./executor-types"

const childSessionID = "ses_wall_clock_child"

function createDeps(): SyncTaskDeps {
  return unsafeTestValue<SyncTaskDeps>({
    createSyncSession: async () => ({ ok: true, sessionID: childSessionID, parentDirectory: "/tmp" }),
    sendSyncPrompt: async () => null,
    pollSyncSession: async () => ({ kind: "wall_clock_yield" }),
    fetchSyncResult: async () => ({ ok: false, error: "unexpected fetch" }),
  })
}

function createExecutorContext(input: { adopt: () => { id: string; description: string; agent: string }; abort: () => void }): ExecutorContext {
  return unsafeTestValue<ExecutorContext>({
    directory: "/tmp",
    client: { session: { abort: async () => { input.abort() } } },
    manager: {
      reserveSubagentSpawn: async () => ({
        spawnContext: { rootSessionID: "ses_root", parentDepth: 0, childDepth: 1 },
        commit: () => {},
        rollback: () => {},
      }),
      adoptRunningSession: input.adopt,
    },
  })
}

afterEach(() => {
  _resetForTesting()
})

describe("executeSyncTask wall-clock yield", () => {
  test("#given poller yield #when adoption succeeds #then returns handle without sync teardown", async () => {
    // given
    let abortCount = 0
    const adopted: Array<{ sessionId: string; rootDescendantAlreadyReserved: boolean }> = []
    const executorCtx = createExecutorContext({
      abort: () => { abortCount++ },
      adopt: (input: { sessionId: string; rootDescendantAlreadyReserved: boolean }) => {
        adopted.push(input)
        return { id: "bg_wallclock", description: "wall-clock task", agent: "sisyphus" }
      },
    })

    // when
    const result = await executeSyncTask(
      { description: "wall-clock task", prompt: "work", load_skills: [], run_in_background: false },
      unsafeTestValue({ sessionID: "ses_parent", messageID: "msg_parent", agent: "sisyphus", abort: new AbortController().signal }),
      executorCtx,
      { sessionID: "ses_parent", messageID: "msg_parent" },
      "sisyphus",
      undefined,
      undefined,
      undefined,
      undefined,
      createDeps(),
    )

    // then
    expect(result).toContain("Background Task ID: bg_wallclock")
    expect(result).toContain("Status: still running")
    expect(adopted).toEqual([expect.objectContaining({
      sessionId: childSessionID,
      rootDescendantAlreadyReserved: true,
    })])
    expect(abortCount).toBe(0)
    expect(handedBackSyncSessions.has(childSessionID)).toBe(false)
    expect(subagentSessions.has(childSessionID)).toBe(true)
  })

  test("#given poller yield #when adoption throws #then aborts unowned child", async () => {
    // given
    let abortCount = 0
    const executorCtx = createExecutorContext({
      abort: () => { abortCount++ },
      adopt: () => { throw new Error("adoption failed") },
    })

    // when
    await executeSyncTask(
      { description: "wall-clock task", prompt: "work", load_skills: [], run_in_background: false },
      unsafeTestValue({ sessionID: "ses_parent", messageID: "msg_parent", agent: "sisyphus", abort: new AbortController().signal }),
      executorCtx,
      { sessionID: "ses_parent", messageID: "msg_parent" },
      "sisyphus",
      undefined,
      undefined,
      undefined,
      undefined,
      createDeps(),
    )

    // then
    expect(abortCount).toBe(1)
  })
})
