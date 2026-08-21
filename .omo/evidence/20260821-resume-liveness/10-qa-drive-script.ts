// QA drive: real BackgroundManager, real resume() path.
// Reproduces the reported symptom (dead child session, task stuck `running`,
// resume rejected) and shows the behavior before vs after the fix.
import { BackgroundManager } from "./packages/omo-opencode/src/features/background-agent/manager"
import type { BackgroundTask } from "./packages/omo-opencode/src/features/background-agent/types"

const DEAD_SESSION = "ses_dead_child"

function makeClient(scenario: "dead" | "busy") {
  return {
    session: {
      // The dead child is absent from the status registry.
      // The busy one is actively working.
      status: async () => ({
        data: scenario === "busy" ? { [DEAD_SESSION]: { type: "busy" } } : {},
      }),
      // Its session ROW still resolves in both cases - this is what makes
      // verifySessionExists() useless as a liveness probe.
      get: async () => ({ data: { id: DEAD_SESSION } }),
      promptAsync: async () => ({}),
      abort: async () => ({ data: true }),
      messages: async () => ({ data: [] }),
    },
  }
}

function seedStuckTask(manager: BackgroundManager, missedPolls: number): BackgroundTask {
  const task: BackgroundTask = {
    id: "bg_qa_stuck",
    sessionId: DEAD_SESSION,
    parentSessionId: "ses_parent",
    parentMessageId: "msg_parent",
    description: "long-running research subagent",
    prompt: "original prompt",
    agent: "explore",
    status: "running",
    startedAt: new Date(Date.now() - 62 * 60_000),
    progress: { toolCalls: 11, lastUpdate: new Date(Date.now() - 41 * 60_000) },
    concurrencyGroup: "explore",
    concurrencyKey: "explore",
    consecutiveMissedPolls: missedPolls,
  } as BackgroundTask
  const tasks = Reflect.get(manager, "tasks") as Map<string, BackgroundTask>
  tasks.set(task.id, task)
  return task
}

async function drive(label: string, scenario: "dead" | "busy", missedPolls: number): Promise<void> {
  const manager = new BackgroundManager({
    pluginContext: { client: makeClient(scenario), directory: "/tmp/qa-resume" } as never,
  })
  const task = seedStuckTask(manager, missedPolls)
  const before = `status=${task.status} concurrencyKey=${task.concurrencyKey ?? "none"}`

  let outcome: string
  try {
    await manager.resume({
      sessionId: DEAD_SESSION,
      prompt: "parent follow-up: continue where you left off",
      parentSessionId: "ses_parent_new",
      parentMessageId: "msg_parent_new",
    })
    for (let i = 0; i < 12; i++) await Promise.resolve()
    outcome = "RESUME ACCEPTED"
  } catch (error) {
    outcome = `RESUME REJECTED: ${(error as Error).message.split(".")[0]}`
  }

  console.log(`\n=== ${label} ===`)
  console.log(`  before:  ${before}`)
  console.log(`  outcome: ${outcome}`)
  console.log(`  after:   status=${task.status} parentSession=${task.parentSessionId}`)
  manager.shutdown()
}

await drive("A. dead child session, seen gone 3+ polls (the reported bug)", "dead", 3)
await drive("B. dead child session, only 1 missed poll (transient blip)", "dead", 1)
await drive("C. genuinely busy session (must still reject)", "busy", 3)
