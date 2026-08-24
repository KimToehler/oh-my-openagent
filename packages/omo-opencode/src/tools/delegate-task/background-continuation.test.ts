const { describe, test, expect, mock } = require("bun:test")

describe("executeBackgroundContinuation - subagent metadata", () => {
  test("reports an error instead of false success when the task is already running", async () => {
    //#given - manager rejects a continuation that cannot be delivered
    const mockManager = {
      findBySession: () => ({ id: "bg_existing" }),
      resume: async () => {
        throw new Error(
          "Task bg_running is currently running and cannot accept a continuation prompt. " +
          "Wait for it to complete before resuming it with task_id.",
        )
      },
    }

    const mockCtx = {
      sessionID: "parent-session",
      callID: "call-running",
      metadata: mock(() => Promise.resolve()),
    }

    const args = {
      task_id: "ses_running_123",
      prompt: "apply updated instructions",
      description: "update running task",
      load_skills: [],
      run_in_background: true,
    }

    //#when
    const { executeBackgroundContinuation } = require("./background-continuation")
    const result = await executeBackgroundContinuation(
      args,
      mockCtx,
      { manager: mockManager },
      {
        sessionID: "parent-session",
        messageID: "msg-parent",
        agent: "sisyphus",
      },
    )

    //#then - the tool cannot claim a continuation that was never delivered
    expect(result).toContain("currently running and cannot accept a continuation prompt")
    expect(result).not.toContain("Background task continued")
  })

  test("includes subagent in task_metadata when task has agent", async () => {
    //#given - mock manager.resume returning task with agent info
    const mockManager = {
      findBySession: () => ({ id: "bg_existing" }),
      resume: async () => ({
        id: "bg_task_001",
        description: "oracle consultation",
        agent: "oracle",
        status: "running",
        sessionId: "ses_resumed_123",
      }),
    }

    const mockCtx = {
      sessionID: "parent-session",
      callID: "call-456",
      metadata: mock(() => Promise.resolve()),
    }

    const mockExecutorCtx = {
      manager: mockManager,
    }

    const parentContext = {
      sessionID: "parent-session",
      messageID: "msg-parent",
      agent: "sisyphus",
    }

    const args = {
      task_id: "ses_resumed_123",
      prompt: "continue working",
      description: "resume oracle",
      load_skills: [],
      run_in_background: true,
    }

    //#when - executeBackgroundContinuation completes
    const { executeBackgroundContinuation } = require("./background-continuation")
    const result = await executeBackgroundContinuation(args, mockCtx, mockExecutorCtx, parentContext)

    //#then - task_metadata should contain subagent field
    expect(result).toContain("<task_metadata>")
    expect(result).toContain("subagent: oracle")
    expect(result).toContain("session_id: ses_resumed_123")
    expect(result).toContain("background_task_id: bg_task_001")
    expect(result).not.toContain("task_id: ses_resumed_123")
    expect(result).toContain("Background Task ID: bg_task_001")
  })

  test("omits subagent from task_metadata when task agent is undefined", async () => {
    //#given - mock manager.resume returning task without agent
    const mockManager = {
      findBySession: () => ({ id: "bg_existing" }),
      resume: async () => ({
        id: "bg_task_002",
        description: "unknown task",
        agent: undefined,
        status: "running",
        sessionId: "ses_resumed_456",
      }),
    }

    const mockCtx = {
      sessionID: "parent-session",
      callID: "call-789",
      metadata: mock(() => Promise.resolve()),
    }

    const mockExecutorCtx = {
      manager: mockManager,
    }

    const parentContext = {
      sessionID: "parent-session",
      messageID: "msg-parent",
      agent: "sisyphus",
    }

    const args = {
      task_id: "ses_resumed_456",
      prompt: "continue",
      description: "resume task",
      load_skills: [],
      run_in_background: true,
    }

    //#when - executeBackgroundContinuation completes without agent
    const { executeBackgroundContinuation } = require("./background-continuation")
    const result = await executeBackgroundContinuation(args, mockCtx, mockExecutorCtx, parentContext)

    //#then - task_metadata should NOT contain subagent field
    expect(result).toContain("<task_metadata>")
    expect(result).toContain("session_id: ses_resumed_456")
    expect(result).not.toContain("subagent:")
  })

  test("discloses fidelity loss after adopting an orphaned server session", async () => {
    //#given - unowned session adopts into a continue task
    const mockManager = {
      findBySession: () => undefined,
      resume: async () => ({
        id: "bg_adopted_001",
        description: "adopted task",
        agent: "continue",
        status: "running",
        sessionId: "ses_orphaned_123",
      }),
    }
    const mockCtx = {
      sessionID: "parent-session",
      callID: "call-adopted",
      metadata: mock(() => Promise.resolve()),
    }
    const args = {
      task_id: "ses_orphaned_123",
      prompt: "continue after restart",
      description: "resume orphaned task",
      load_skills: [],
      run_in_background: true,
    }

    //#when - orphaned session resumes successfully
    const { executeBackgroundContinuation } = require("./background-continuation")
    const result = await executeBackgroundContinuation(args, mockCtx, { manager: mockManager }, {
      sessionID: "parent-session",
      messageID: "msg-parent",
      agent: "sisyphus",
    })

    //#then - caller receives adopted-task fidelity disclosure
    expect(result).toContain("This continuation adopted an orphaned server session using agent: continue.")
    expect(result).toContain("It has no original model, no fallback chain, no category, and no loaded skill content.")
    expect(result).toContain("It will not auto-fall-back on a model error.")
  })

  test("keeps normal known-task continuation output free of adopted-task disclosure", async () => {
    //#given - tracked session resumes normally
    const mockManager = {
      findBySession: () => ({ id: "bg_known_001" }),
      resume: async () => ({
        id: "bg_known_001",
        description: "known task",
        agent: "oracle",
        status: "running",
        sessionId: "ses_known_123",
      }),
    }
    const mockCtx = {
      sessionID: "parent-session",
      callID: "call-known",
      metadata: mock(() => Promise.resolve()),
    }
    const args = {
      task_id: "ses_known_123",
      prompt: "continue normally",
      description: "resume known task",
      load_skills: [],
      run_in_background: true,
    }

    //#when - known session resumes successfully
    const { executeBackgroundContinuation } = require("./background-continuation")
    const result = await executeBackgroundContinuation(args, mockCtx, { manager: mockManager }, {
      sessionID: "parent-session",
      messageID: "msg-parent",
      agent: "sisyphus",
    })

    //#then - normal output keeps its existing shape
    expect(result).toContain("Background task continued.")
    expect(result).toContain("Agent continues with full previous context preserved.")
    expect(result).not.toContain("This continuation adopted an orphaned server session")
  })

  test("does not advertise background_output CTA in continuation return (issue #5221)", async () => {
    //#given - mock manager.resume
    const mockManager = {
      findBySession: () => ({ id: "bg_existing" }),
      resume: async () => ({
        id: "bg_task_cta",
        description: "continue task",
        agent: "oracle",
        status: "running",
        sessionId: "ses_resumed_cta",
      }),
    }

    const mockCtx = {
      sessionID: "parent-session",
      callID: "call-cta",
      metadata: mock(() => Promise.resolve()),
    }

    const mockExecutorCtx = {
      manager: mockManager,
    }

    const parentContext = {
      sessionID: "parent-session",
      messageID: "msg-parent",
      agent: "sisyphus",
    }

    const args = {
      task_id: "ses_resumed_cta",
      prompt: "continue",
      description: "resume task",
      load_skills: [],
      run_in_background: true,
    }

    //#when
    const { executeBackgroundContinuation } = require("./background-continuation")
    const result = await executeBackgroundContinuation(args, mockCtx, mockExecutorCtx, parentContext)

    //#then - no polling CTA, anti-polling instruction preserved
    expect(result).not.toContain("Use `background_output` with task_id=")
    expect(result).not.toContain("to check.")
    expect(result).toContain("Do NOT call background_output now")
    expect(result).toContain("<system-reminder>")
  })
})
