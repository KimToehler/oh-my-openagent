import { describe, test, expect } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildBackgroundTaskNotificationText,
  type BackgroundTaskNotificationTask,
} from "./background-task-notification-template"
import { countNewDirtyPaths, parsePorcelainPaths, readDirtyWorktreeStatus } from "./dirty-worktree"

describe("parsePorcelainPaths", () => {
  test("#given null-delimited ordinary staged untracked and renamed entries #when parsed #then each normalized worktree path is returned", () => {
    //#given
    const porcelain = " M packages/a/src/index.ts\0A  packages/a/src/added.ts\0?? packages/a/src/new file.ts\0R  packages/a/src/renamed.ts\0packages/a/src/old-name.ts\0"

    //#when
    const paths = parsePorcelainPaths(porcelain)

    //#then
    expect(paths).toEqual(new Set([
      "packages/a/src/index.ts",
      "packages/a/src/added.ts",
      "packages/a/src/new file.ts",
      "packages/a/src/renamed.ts",
    ]))
    expect(paths.has("packages/a/src/old-name.ts")).toBeFalse()
  })

  test("#given completion paths containing a baseline path and a new path #when delta is counted #then only new path is counted", () => {
    //#given
    const baselinePaths = new Set(["packages/a/src/existing.ts"])
    const completionPaths = new Set(["packages/a/src/existing.ts", "packages/a/src/new.ts"])

    //#when
    const count = countNewDirtyPaths(baselinePaths, completionPaths)

    //#then
    expect(count).toBe(1)
  })

  test("#given identical baseline and completion paths #when delta is counted #then no annotation count is returned", () => {
    //#given
    const paths = new Set(["packages/a/src/existing.ts"])

    //#when
    const count = countNewDirtyPaths(paths, paths)

    //#then
    expect(count).toBeUndefined()
  })

  test("#given a directory outside a Git worktree #when status is read #then availability is reported as unavailable", async () => {
    //#given
    const directory = await mkdtemp(join(tmpdir(), "omo-dirty-worktree-"))

    //#when
    const status = await readDirtyWorktreeStatus(directory)

    //#then
    expect(status).toEqual({ kind: "unavailable" })
  })
})

function renderCompletion(task: BackgroundTaskNotificationTask): string {
  return buildBackgroundTaskNotificationText({
    task,
    duration: "1m 0s",
    statusText: "COMPLETED",
    allComplete: true,
    remainingCount: 0,
    completedTasks: [task],
  })
}

describe("buildBackgroundTaskNotificationText - lane that completed over a dirty worktree", () => {
  test("#given a lane that completed while leaving uncommitted files behind #when the completion notification is rendered #then it reports the uncommitted work instead of reading as a clean completion", () => {
    //#given
    const task: BackgroundTaskNotificationTask = {
      id: "task-dirty",
      description: "refactor the parser",
      status: "completed",
      sessionId: "session-dirty",
      completionReason: "idle-status",
      uncommittedFileCount: 4,
    }

    //#when
    const rendered = renderCompletion(task)

    //#then
    expect(rendered).toContain("completed with 4 uncommitted files")
  })

  test("#given a lane that completed with one uncommitted file #when the completion notification is rendered #then it uses singular file wording", () => {
    //#given
    const task: BackgroundTaskNotificationTask = {
      id: "task-one-file",
      description: "refactor the parser",
      status: "completed",
      sessionId: "session-one-file",
      completionReason: "idle-status",
      uncommittedFileCount: 1,
    }

    //#when
    const rendered = renderCompletion(task)

    //#then
    expect(rendered).toContain("completed with 1 uncommitted file")
  })

  test("#given a lane with unfinished todos and uncommitted files #when the completion notification is rendered #then it uses one coherent completion suffix", () => {
    //#given
    const task: BackgroundTaskNotificationTask = {
      id: "task-both",
      description: "refactor the parser",
      status: "completed",
      sessionId: "session-both",
      completionReason: "idle-status",
      unfinishedTodoCount: 2,
      uncommittedFileCount: 4,
    }

    //#when
    const rendered = renderCompletion(task)

    //#then
    expect(rendered).toContain("completed with 2 unfinished todos and 4 uncommitted files")
  })

  test("#given a lane that completed with a clean worktree #when the completion notification is rendered #then no uncommitted-work annotation appears", () => {
    //#given
    const task: BackgroundTaskNotificationTask = {
      id: "task-clean",
      description: "refactor the parser",
      status: "completed",
      sessionId: "session-clean",
      completionReason: "idle-status",
      uncommittedFileCount: 0,
    }

    //#when
    const rendered = renderCompletion(task)

    //#then
    expect(rendered).not.toContain("uncommitted")
  })
})
