// QA drive: real formatTaskStatus, the renderer background_output uses.
// Shows what the parent agent is told about a task whose child has gone silent.
import { formatTaskStatus } from "./packages/omo-opencode/src/tools/background-task/task-status-format"
import type { BackgroundTask } from "./packages/omo-opencode/src/features/background-agent"

function task(label: string, overrides: Partial<BackgroundTask>): BackgroundTask {
  const now = Date.now()
  return {
    id: "bg_qa_status",
    sessionId: "ses_child",
    parentSessionId: "ses_parent",
    parentMessageId: "msg_parent",
    description: label,
    prompt: "run the long research job",
    agent: "explore",
    status: "running",
    startedAt: new Date(now - 62 * 60_000),
    ...overrides,
  } as BackgroundTask
}

const now = Date.now()
const cases: Array<[string, BackgroundTask]> = [
  ["A. healthy running task (activity 30s ago)", task("healthy", {
    progress: { toolCalls: 7, lastUpdate: new Date(now - 30_000) },
  } as Partial<BackgroundTask>)],
  ["B. dead child, silent 47m (the reported symptom)", task("silent", {
    progress: { toolCalls: 7, lastUpdate: new Date(now - 47 * 60_000) },
  } as Partial<BackgroundTask>)],
  ["C. child missing from session registry for 3 polls", task("unregistered", {
    progress: { toolCalls: 7, lastUpdate: new Date(now - 2 * 60_000) },
    consecutiveMissedPolls: 3,
  } as Partial<BackgroundTask>)],
]

for (const [label, t] of cases) {
  const out = formatTaskStatus(t)
  const statusRow = out.split("\n").find(l => l.startsWith("| Status")) ?? "(no status row)"
  const durationRow = out.split("\n").find(l => l.startsWith("| Duration")) ?? "(no duration row)"
  const note = out.split("\n").find(l => l.startsWith("> **Note**")) ?? "(no note)"
  console.log(`\n=== ${label} ===`)
  console.log(`  ${statusRow.trim()}`)
  console.log(`  ${durationRow.trim()}`)
  console.log(`  ${note.trim()}`)
}
