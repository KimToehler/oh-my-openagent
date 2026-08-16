/// <reference types="bun-types" />

import { describe, test, expect, mock } from "bun:test"
import { tmpdir } from "node:os"
import type { PluginInput } from "@opencode-ai/plugin"
import type { BackgroundTaskConfig } from "../../config/schema"
import { BackgroundManager } from "./manager"
import { MIN_SESSION_GONE_POLLS } from "./session-existence"
import type { BackgroundTask } from "./types"

function createPluginContext(client: object): PluginInput {
  const directory = tmpdir()
  return {
    project: {
      id: "test-project",
      worktree: directory,
      time: { created: Date.now() },
    },
    directory,
    worktree: directory,
    serverUrl: new URL("http://localhost:4096"),
    $: {} as PluginInput["$"],
    client: client as PluginInput["client"],
  }
}

function createManagerWithStatus(statusImpl: () => Promise<{ data: Record<string, { type: string }> }>): BackgroundManager {
  const client = {
    session: {
      status: statusImpl,
      prompt: async () => ({}),
      promptAsync: async () => ({}),
      abort: async () => ({}),
      todo: async () => ({ data: [] }),
      messages: async () => ({ data: [] }),
    },
  }

  return new BackgroundManager({ pluginContext: createPluginContext(client) })
}

describe("BackgroundManager polling overlap", () => {
  test("skips overlapping pollRunningTasks executions", async () => {
    //#given
    let activeCalls = 0
    let maxActiveCalls = 0
    let statusCallCount = 0
    let releaseStatus: (() => void) | undefined
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve
    })

    const manager = createManagerWithStatus(async () => {
      statusCallCount += 1
      activeCalls += 1
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls)
      await statusGate
      activeCalls -= 1
      return { data: {} }
    })

    //#when
    const firstPoll = manager["pollRunningTasks"]()
    await Promise.resolve()
    const secondPoll = manager["pollRunningTasks"]()
    releaseStatus?.()
    await Promise.all([firstPoll, secondPoll])
    manager.shutdown()

    //#then
    expect(maxActiveCalls).toBe(1)
    expect(statusCallCount).toBe(1)
  })
})


function createRunningTask(sessionId: string): BackgroundTask {
  return {
    id: `bg_test_${sessionId}`,
    sessionId,
    parentSessionId: "parent-session",
    parentMessageId: "parent-msg",
    description: "test task",
    prompt: "test",
    agent: "explore",
    status: "running",
    startedAt: new Date(),
    progress: { toolCalls: 0, lastUpdate: new Date() },
  }
}

function injectTask(manager: BackgroundManager, task: BackgroundTask): void {
  manager["tasks"].set(task.id, task)
}

function createManagerWithClient(
  clientOverrides: Record<string, unknown> = {},
  config?: BackgroundTaskConfig,
): BackgroundManager {
  const client = {
    session: {
      status: async () => ({ data: {} }),
      get: async () => ({ data: { id: "ses-default" } }),
      prompt: async () => ({}),
      promptAsync: async () => ({}),
      abort: async () => ({}),
      todo: async () => ({ data: [] }),
      messages: async () => ({
        data: [{
          info: { role: "assistant", finish: "end_turn", id: "msg-2" },
          parts: [{ type: "text", text: "done" }],
        }, {
          info: { role: "user", id: "msg-1" },
          parts: [{ type: "text", text: "go" }],
        }],
      }),
      ...clientOverrides,
    },
  }
  return new BackgroundManager(
    { pluginContext: createPluginContext(client), config, enableParentSessionNotifications: false },
  )
}

describe("BackgroundManager verifySessionExists", () => {
  describe("#given session.get reports a not-found response", () => {
    test("#when verifySessionExists runs #then it returns false", async () => {
      //#given
      const manager = createManagerWithClient({
        get: async () => ({
          error: { message: "Session not found", status: 404 },
          data: undefined,
        }),
      })

      //#when
      const result = await manager["verifySessionExists"]("ses-missing")
      await manager.shutdown()

      //#then
      expect(result).toBe(false)
    })
  })

  describe("#given session.get reports a transient transport error", () => {
    test("#when verifySessionExists runs #then it returns true", async () => {
      //#given
      const manager = createManagerWithClient({
        get: async () => ({
          error: { message: "Network timeout", status: 500 },
          data: undefined,
        }),
      })

      //#when
      const result = await manager["verifySessionExists"]("ses-transient")
      await manager.shutdown()

      //#then
      expect(result).toBe(true)
    })
  })
})

describe("BackgroundManager pollRunningTasks", () => {
  describe("#given a running task whose session is no longer in status response", () => {
    test("#when pollRunningTasks runs #then completes the task instead of leaving it running", async () => {
      //#given
      const manager = createManagerWithClient()
      const task = createRunningTask("ses-gone")
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("completed")
      expect(task.completedAt).toBeDefined()
    })

    test("#when the first missing-status poll has no output #then it does not fail the task yet", async () => {
      //#given
      const getSession = mock(async () => ({
        error: { message: "Session not found", status: 404 },
        data: undefined,
      }))
      const manager = createManagerWithClient({
        get: getSession,
        messages: async () => ({ data: [] }),
      })
      const task = createRunningTask("ses-first-miss")
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      await manager.shutdown()

      //#then
      expect(task.status).toBe("running")
      expect(task.error).toBeUndefined()
      expect(task.consecutiveMissedPolls).toBe(1)
      expect(getSession).not.toHaveBeenCalled()
    })

    test("#when status polling is unavailable #then it does not complete or increment missed polls", async () => {
      const cases: Array<{ name: string; status?: (() => Promise<{ data: Record<string, { type: string }> }>) | undefined }> = [
        { name: "missing status method", status: undefined },
        { name: "throwing status method", status: async () => { throw new Error("status unavailable") } },
      ]

      for (const testCase of cases) {
        //#given
        let abortCallCount = 0
        const manager = createManagerWithClient({
          status: testCase.status,
          abort: async () => {
            abortCallCount += 1
            return {}
          },
        })
        const task = createRunningTask(`ses-${testCase.name.replace(/ /g, "-")}`)
        injectTask(manager, task)

        //#when
        const poll = manager["pollRunningTasks"]
        for (let count = 0; count < MIN_SESSION_GONE_POLLS + 1; count += 1) {
          await poll.call(manager)
        }

        //#then
        expect(task.status).toBe("running")
        expect(task.completedAt).toBeUndefined()
        expect(task.error).toBeUndefined()
        expect(task.consecutiveMissedPolls ?? 0).toBe(0)
        expect(abortCallCount).toBe(0)

        await manager.shutdown()
      }
    })

    test("#when reliable status polling omits the session #then it completes through the session-gone path", async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: {} }),
      })
      const task = createRunningTask("ses-reliably-gone")
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      for (let count = 0; count < MIN_SESSION_GONE_POLLS; count += 1) {
        await poll.call(manager)
      }
      await manager.shutdown()

      //#then
      expect(task.status).toBe("completed")
      expect(task.completedAt).toBeDefined()
    })
  })

  describe("#given a running task whose session status is idle", () => {
    test("#when pollRunningTasks runs #then completes the task", async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-idle": { type: "idle" } } }),
      })
      const task = createRunningTask("ses-idle")
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("completed")
    })

    test("#when output was already observed from events #then it completes without fetching messages", async () => {
      //#given
      let messagesCallCount = 0
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-idle-cached": { type: "idle" } } }),
        messages: async () => {
          messagesCallCount += 1
          return {
            data: [{
              info: { role: "assistant", finish: "end_turn", id: "msg-2" },
              parts: [{ type: "text", text: "done" }],
            }],
          }
        },
      })
      const task = createRunningTask("ses-idle-cached")
      injectTask(manager, task)

      manager.handleEvent({
        type: "message.part.updated",
        properties: { sessionID: "ses-idle-cached", type: "text" },
      })

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("completed")
      expect(messagesCallCount).toBe(0)
    })

    test("#when todo state was already observed from events #then it completes without fetching todos", async () => {
      //#given
      let todoCallCount = 0
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-idle-todo-cached": { type: "idle" } } }),
        todo: async () => {
          todoCallCount += 1
          return { data: [] }
        },
      })
      const task = createRunningTask("ses-idle-todo-cached")
      injectTask(manager, task)

      manager.handleEvent({
        type: "message.part.updated",
        properties: { sessionID: "ses-idle-todo-cached", type: "text" },
      })
      manager.handleEvent({
        type: "todo.updated",
        properties: {
          sessionID: "ses-idle-todo-cached",
          todos: [
            { id: "todo-1", content: "done", status: "completed", priority: "high" },
          ],
        },
      })

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("completed")
      expect(todoCallCount).toBe(0)
    })

    test("#when cached incomplete todos become complete before idle polling #then refreshes todos and completes", async () => {
      //#given
      let todoCallCount = 0
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-idle-stale-todos": { type: "idle" } } }),
        todo: async () => {
          todoCallCount += 1
          return {
            data: [
              { content: "compile result", status: "completed", priority: "high" },
            ],
          }
        },
      })
      const task = createRunningTask("ses-idle-stale-todos")
      injectTask(manager, task)

      manager.handleEvent({
        type: "message.part.updated",
        properties: { sessionID: "ses-idle-stale-todos", type: "text" },
      })
      manager.handleEvent({
        type: "todo.updated",
        properties: {
          sessionID: "ses-idle-stale-todos",
          todos: [
            { content: "compile result", status: "in_progress", priority: "high" },
          ],
        },
      })

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("completed")
      expect(todoCallCount).toBe(1)
    })
  })

  describe("#given idle output with incomplete todos", () => {
    const fixedNow = new Date("2026-08-17T12:00:00.000Z").getTime()
    const graceMs = 60_000

    function createTodoGateTask(sessionId: string): BackgroundTask {
      const task = createRunningTask(sessionId)
      task.startedAt = new Date(fixedNow - graceMs * 3)
      task.progress = { toolCalls: 1, lastUpdate: new Date(fixedNow - graceMs * 2) }
      task.todoGateFirstObservedAt = new Date(fixedNow - graceMs * 2)
      return task
    }

    function incompleteTodos(count = 3): { data: Array<{ content: string; status: string; priority: string }> } {
      return {
        data: Array.from({ length: count }, (_, index) => ({
          content: `unfinished ${index + 1}`,
          status: "in_progress",
          priority: "high",
        })),
      }
    }

    test("#when both grace conditions expire #then completes with unfinished count", async () => {
      //#given
      const originalDateNow = Date.now
      Date.now = () => fixedNow
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-expired": { type: "idle" } } }),
        todo: async () => incompleteTodos(),
      }, { todoGateGraceMs: graceMs })
      const task = createTodoGateTask("ses-expired")
      injectTask(manager, task)

      try {
        //#when
        await manager["pollRunningTasks"]()

        //#then
        expect(task.status).toBe("completed")
        expect(task.unfinishedTodoCount).toBe(3)
      } finally {
        Date.now = originalDateNow
        await manager.shutdown()
      }
    })

    test("#when session remains active #then keeps task running", async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-active-gate": { type: "busy" } } }),
        todo: async () => incompleteTodos(),
      }, { todoGateGraceMs: graceMs })
      const task = createTodoGateTask("ses-active-gate")
      injectTask(manager, task)

      //#when
      await manager["pollRunningTasks"]()

      //#then
      expect(task.status).toBe("running")
      await manager.shutdown()
    })

    test("#when valid output is absent #then keeps task running", async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-no-output": { type: "idle" } } }),
        messages: async () => ({ data: [] }),
        todo: async () => incompleteTodos(),
      }, { todoGateGraceMs: graceMs })
      const task = createTodoGateTask("ses-no-output")
      injectTask(manager, task)

      //#when
      await manager["pollRunningTasks"]()

      //#then
      expect(task.status).toBe("running")
      expect(task.unfinishedTodoCount).toBeUndefined()
      await manager.shutdown()
    })

    test("#when first observation is inside grace window #then stamps and waits", async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-fresh-gate": { type: "idle" } } }),
        todo: async () => incompleteTodos(1),
      }, { todoGateGraceMs: graceMs })
      const task = createTodoGateTask("ses-fresh-gate")
      task.todoGateFirstObservedAt = undefined
      injectTask(manager, task)

      //#when
      await manager["pollRunningTasks"]()

      //#then
      expect(task.status).toBe("running")
      expect(task.todoGateFirstObservedAt).toBeDefined()
      await manager.shutdown()
    })

    test("#when user and internal-wake parts arrive #then preserves the stamp", async () => {
      //#given
      const manager = createManagerWithClient()
      const task = createTodoGateTask("ses-synthetic-parts")
      const originalStamp = task.todoGateFirstObservedAt
      injectTask(manager, task)

      //#when
      manager.handleEvent({
        type: "message.part.updated",
        properties: {
          sessionID: task.sessionId,
          part: { sessionID: task.sessionId, role: "user", type: "text", text: "continue" },
        },
      })
      manager.handleEvent({
        type: "message.part.updated",
        properties: {
          sessionID: task.sessionId,
          part: {
            sessionID: task.sessionId,
            role: "user",
            type: "text",
            text: "<system-reminder>wake</system-reminder><!-- OMO_INTERNAL_INITIATOR -->",
          },
        },
      })

      //#then
      expect(task.todoGateFirstObservedAt).toEqual(originalStamp)
      await manager.shutdown()
    })

    test("#when assistant and tool parts arrive #then clears the stamp", async () => {
      //#given
      const manager = createManagerWithClient()
      const assistantTask = createTodoGateTask("ses-assistant-part")
      const toolTask = createTodoGateTask("ses-tool-part")
      injectTask(manager, assistantTask)
      injectTask(manager, toolTask)

      //#when
      manager.handleEvent({
        type: "message.part.updated",
        properties: {
          sessionID: assistantTask.sessionId,
          part: { sessionID: assistantTask.sessionId, role: "assistant", type: "text", text: "work" },
        },
      })
      manager.handleEvent({
        type: "message.part.updated",
        properties: {
          sessionID: toolTask.sessionId,
          part: { sessionID: toolTask.sessionId, role: "assistant", type: "tool", tool: "bash" },
        },
      })

      //#then
      expect(assistantTask.todoGateFirstObservedAt).toBeUndefined()
      expect(toolTask.todoGateFirstObservedAt).toBeUndefined()
      await manager.shutdown()
    })

    test("#when only observed-stamp grace expires #then recent progress keeps task running", async () => {
      //#given
      const originalDateNow = Date.now
      Date.now = () => fixedNow
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-recent-progress": { type: "idle" } } }),
        todo: async () => incompleteTodos(2),
      }, { todoGateGraceMs: graceMs })
      const task = createTodoGateTask("ses-recent-progress")
      task.progress = { toolCalls: 2, lastUpdate: new Date(fixedNow - graceMs / 2) }
      injectTask(manager, task)

      try {
        //#when
        await manager["pollRunningTasks"]()

        //#then
        expect(task.status).toBe("running")
        expect(task.unfinishedTodoCount).toBeUndefined()
      } finally {
        Date.now = originalDateNow
        await manager.shutdown()
      }
    })

    test("#when progress refreshes during output validation #then final activity re-read keeps task running", async () => {
      //#given
      const originalDateNow = Date.now
      Date.now = () => fixedNow
      let task: BackgroundTask
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-interleaved-progress": { type: "idle" } } }),
        messages: async () => {
          task.progress = { toolCalls: 2, lastUpdate: new Date(fixedNow) }
          return {
            data: [{
              info: { role: "assistant", finish: "end_turn", id: "msg-output" },
              parts: [{ type: "text", text: "done" }],
            }],
          }
        },
        todo: async () => incompleteTodos(2),
      }, { todoGateGraceMs: graceMs })
      task = createTodoGateTask("ses-interleaved-progress")
      injectTask(manager, task)

      try {
        //#when
        await manager["pollRunningTasks"]()

        //#then
        expect(task.status).toBe("running")
        expect(task.progress?.lastUpdate.getTime()).toBe(fixedNow)
      } finally {
        Date.now = originalDateNow
        await manager.shutdown()
      }
    })

    test("#when incomplete todos are checked twice #then cached result retains the count", async () => {
      //#given
      let todoCallCount = 0
      const manager = createManagerWithClient({
        todo: async () => {
          todoCallCount += 1
          return incompleteTodos(4)
        },
      })
      const checkSessionTodos = Reflect.get(manager, "checkSessionTodos") as (
        sessionId: string,
      ) => Promise<{ hasIncompleteTodos: boolean; incompleteTodoCount: number }>

      //#when
      const first = await checkSessionTodos.call(manager, "ses-cached-count")
      const second = await checkSessionTodos.call(manager, "ses-cached-count")

      //#then
      expect(first).toEqual({ hasIncompleteTodos: true, incompleteTodoCount: 4 })
      expect(second).toEqual({ hasIncompleteTodos: true, incompleteTodoCount: 4 })
      expect(todoCallCount).toBe(2)
      await manager.shutdown()
    })
  })

  describe("#given a running task whose session status is busy", () => {
    test("#when pollRunningTasks runs #then keeps the task running", async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-busy": { type: "busy" } } }),
      })
      const task = createRunningTask("ses-busy")
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("running")
    })

    test("#when progress is older than prune TTL #then active status still keeps the task running", async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-busy-stale": { type: "busy" } } }),
      })
      const task = createRunningTask("ses-busy-stale")
      task.startedAt = new Date(Date.now() - 60 * 60 * 1000)
      task.progress = {
        toolCalls: 4,
        lastUpdate: new Date(Date.now() - 35 * 60 * 1000),
      }
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("running")
      expect(task.error).toBeUndefined()
    })
  })

  describe("#given a running task whose session has terminal non-idle status", () => {
    test('#when session status is "interrupted" #then completes the task', async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-interrupted": { type: "interrupted" } } }),
      })
      const task = createRunningTask("ses-interrupted")
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("completed")
      expect(task.completedAt).toBeDefined()
    })

    test('#when session status is an unknown type #then completes the task', async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-unknown": { type: "some-weird-status" } } }),
      })
      const task = createRunningTask("ses-unknown")
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("completed")
      expect(task.completedAt).toBeDefined()
    })
  })
})
