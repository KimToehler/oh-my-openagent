import { spawn } from "bun"
import { describe, test, expect } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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

describe("readDirtyWorktreeStatus against a real repository", () => {
  test("#given a lane that created a new directory of five files #when the worktree status is read #then every file is counted, not the collapsed directory entry", async () => {
    //#given
    const repo = await mkdtemp(join(tmpdir(), "omo-dirty-untracked-"))
    const run = async (...args: string[]): Promise<void> => {
      const child = spawn(["git", "-C", repo, ...args], { stdout: "ignore", stderr: "ignore" })
      await child.exited
    }
    await run("init", "-q", ".")
    await run("config", "user.email", "qa@example.com")
    await run("config", "user.name", "qa")
    await mkdir(join(repo, "brandnew"), { recursive: true })
    for (const name of ["f1.ts", "f2.ts", "f3.ts", "f4.ts", "f5.ts"]) {
      await writeFile(join(repo, "brandnew", name), "export const x = 1\n")
    }

    //#when
    const status = await readDirtyWorktreeStatus(repo)

    //#then
    // Plain `--porcelain` collapses this to a single `?? brandnew/` entry, which
    // would report one dirtied file instead of five.
    if (status.kind !== "available") throw new Error("expected an available status")
    expect(status.paths.size).toBe(5)
    expect(status.paths.has("brandnew/f3.ts")).toBe(true)

    await rm(repo, { recursive: true, force: true })
  })

  test("#given a lane that added files into a directory already untracked at baseline #when the delta is counted #then the newly added files are still surfaced", async () => {
    //#given
    const repo = await mkdtemp(join(tmpdir(), "omo-dirty-baseline-"))
    const run = async (...args: string[]): Promise<void> => {
      const child = spawn(["git", "-C", repo, ...args], { stdout: "ignore", stderr: "ignore" })
      await child.exited
    }
    await run("init", "-q", ".")
    await mkdir(join(repo, "scratch"), { recursive: true })
    await writeFile(join(repo, "scratch", "pre-existing.ts"), "export const a = 1\n")
    const baseline = await readDirtyWorktreeStatus(repo)

    //#when
    await writeFile(join(repo, "scratch", "lane-wrote-this.ts"), "export const b = 2\n")
    const completion = await readDirtyWorktreeStatus(repo)

    //#then
    // Under directory collapse both reads would be the single entry `scratch/`,
    // the delta would be zero, and the lane would report nothing at all.
    if (baseline.kind !== "available" || completion.kind !== "available") {
      throw new Error("expected available statuses")
    }
    expect(countNewDirtyPaths(baseline.paths, completion.paths)).toBe(1)

    await rm(repo, { recursive: true, force: true })
  })
})

describe("uncommitted-work reporting on non-completed lanes", () => {
  test("#given a lane that was cancelled while holding uncommitted work #when its summary line is rendered #then the stranded file count is stated", () => {
    //#given
    const task: BackgroundTaskNotificationTask = {
      id: "task-interrupted",
      description: "migrate the parser",
      status: "cancelled",
      sessionId: "session-interrupted",
      error: "Parent session was interrupted",
      uncommittedFileCount: 3,
    }

    //#when
    const rendered = renderCompletion(task)

    //#then
    // The interrupted lane is the likeliest to have stranded work, and was
    // previously the only status that reported none.
    expect(rendered).toContain("left 3 uncommitted files")
  })

  test("#given a cancelled lane that left exactly one file #when its summary line is rendered #then the count is singular", () => {
    //#given
    const task: BackgroundTaskNotificationTask = {
      id: "task-one-file",
      description: "tweak a config",
      status: "cancelled",
      sessionId: "session-one-file",
      uncommittedFileCount: 1,
    }

    //#when
    const rendered = renderCompletion(task)

    //#then
    expect(rendered).toContain("left 1 uncommitted file")
    expect(rendered).not.toContain("uncommitted files")
  })

  test("#given a cancelled lane that left a clean tree #when its summary line is rendered #then no uncommitted annotation appears", () => {
    //#given
    const task: BackgroundTaskNotificationTask = {
      id: "task-cancelled-clean",
      description: "read some files",
      status: "cancelled",
      sessionId: "session-cancelled-clean",
      uncommittedFileCount: 0,
    }

    //#when
    const rendered = renderCompletion(task)

    //#then
    expect(rendered).not.toContain("uncommitted")
  })
})
