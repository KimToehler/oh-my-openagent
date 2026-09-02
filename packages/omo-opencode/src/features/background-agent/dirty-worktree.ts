import { log } from "../../shared"
// The runtime shim, never `import { spawn } from "bun"`. A direct Bun import
// bundles to `globalThis.Bun`, which is undefined under Node and makes the whole
// dist bundle fail to load. `dist-bundle-bun-globals.test.ts` pins that.
import { spawn } from "../../shared/bun-spawn-shim"

export type DirtyWorktreeStatus =
  | { readonly kind: "available"; readonly paths: ReadonlySet<string> }
  | { readonly kind: "unavailable" }

export type DirtyWorktreeStatusReader = (directory: string) => Promise<DirtyWorktreeStatus>

export function parsePorcelainPaths(porcelain: string): Set<string> {
  const entries = porcelain.split("\0")
  const paths = new Set<string>()

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry === undefined || entry.length < 4) continue

    const path = entry.slice(3)
    paths.add(path)

    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") {
      index += 1
    }
  }

  return paths
}

export function countNewDirtyPaths(
  baselinePaths: ReadonlySet<string>,
  completionPaths: ReadonlySet<string>,
): number | undefined {
  let count = 0
  for (const path of completionPaths) {
    if (!baselinePaths.has(path)) count += 1
  }

  return count > 0 ? count : undefined
}

const UNAVAILABLE: DirtyWorktreeStatus = { kind: "unavailable" }

/** A dirty-tree read is cosmetic, so it must never outlive a lane's completion. */
const READ_TIMEOUT_MS = 5_000

/**
 * `--untracked-files=all` is load-bearing, not a preference. Plain `--porcelain`
 * collapses a new directory to one `?? dir/` entry, so a lane that created five
 * files reports one, and a lane that added files to a directory already
 * untracked at baseline reports zero. That is silence in exactly the case this
 * annotation exists to surface. Matches `packages/memory-core/src/git/repo.ts`.
 */
export async function readDirtyWorktreeStatus(directory: string): Promise<DirtyWorktreeStatus> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined

  try {
    const startedChild = spawn(
      ["git", "-C", directory, "status", "--porcelain", "-z", "--untracked-files=all"],
      { stdout: "pipe", stderr: "ignore" },
    )

    const read = Promise.all([
      startedChild.exited,
      new Response(startedChild.stdout).text(),
    ]).then(([exitCode, output]) => ({ exitCode, output }) as const)

    const timedOut = new Promise<"timed_out">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timed_out"), READ_TIMEOUT_MS)
    })

    const result = await Promise.race([read, timedOut])

    if (result === "timed_out") {
      log("[background-agent] Dirty-worktree read timed out:", { directory })
      startedChild.kill("SIGKILL")
      return UNAVAILABLE
    }

    if (result.exitCode !== 0) {
      log("[background-agent] Dirty-worktree read failed:", {
        directory,
        exitCode: result.exitCode,
      })
      return UNAVAILABLE
    }

    return { kind: "available", paths: parsePorcelainPaths(result.output) }
  } catch (error) {
    log("[background-agent] Dirty-worktree read threw:", { directory, error })
    return UNAVAILABLE
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}
