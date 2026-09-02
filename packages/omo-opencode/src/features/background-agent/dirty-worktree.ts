import { spawn } from "bun"

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

export async function readDirtyWorktreeStatus(directory: string): Promise<DirtyWorktreeStatus> {
  try {
    const process = spawn(["git", "-C", directory, "status", "--porcelain", "-z"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const [exitCode, output] = await Promise.all([process.exited, new Response(process.stdout).text()])

    if (exitCode !== 0) return { kind: "unavailable" }
    return { kind: "available", paths: parsePorcelainPaths(output) }
  } catch (error) {
    if (error instanceof Error) return { kind: "unavailable" }
    throw error
  }
}
