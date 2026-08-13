import { basename, dirname } from "node:path"

import { spawnSync } from "../../shared/bun-spawn-shim"

export type GitRunResult = { readonly exitCode: number; readonly stdout: string }

export type ResolveRepoOriginDeps = {
  readonly runGit?: (args: readonly string[], cwd: string) => GitRunResult
}

export type RepoOrigin = {
  readonly repoName: string
  readonly commitSha: string
}

export const UNKNOWN_COMMIT_SHA = "unknown"

const SCP_REMOTE_RE = /^[^/]+@[^/:]+:(?<path>.+)$/

function defaultRunGit(args: readonly string[], cwd: string): GitRunResult {
  const result = spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  return { exitCode: result.exitCode, stdout: result.stdout?.toString() ?? "" }
}

function readGit(runGit: NonNullable<ResolveRepoOriginDeps["runGit"]>, args: readonly string[], cwd: string): string | undefined {
  const result = runGit(args, cwd)
  if (result.exitCode !== 0) return undefined
  const value = result.stdout.trim()
  return value.length > 0 ? value : undefined
}

function repoNameFromRemoteUrl(remoteUrl: string): string | undefined {
  const scpPath = SCP_REMOTE_RE.exec(remoteUrl)?.groups?.path
  const pathPart = scpPath ?? remoteUrl.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/, "")
  const segments = pathPart.split("/").filter((segment) => segment.length > 0)
  const last = segments.at(-1)
  if (last === undefined) return undefined
  const slug = last.replace(/\.git$/, "")
  return slug.length > 0 ? slug : undefined
}

function repoNameFromCommonDir(commonDir: string): string | undefined {
  const parent = basename(dirname(commonDir))
  return parent.length > 0 ? parent : undefined
}

function resolveRepoName(runGit: NonNullable<ResolveRepoOriginDeps["runGit"]>, projectDir: string): string {
  const remoteUrl = readGit(runGit, ["remote", "get-url", "origin"], projectDir)
  const fromRemote = remoteUrl === undefined ? undefined : repoNameFromRemoteUrl(remoteUrl)
  if (fromRemote !== undefined) return fromRemote

  // Worktrees share the main checkout's common git dir, so its parent names the repo
  // even when basename(projectDir) is only the worktree folder.
  const commonDir = readGit(runGit, ["rev-parse", "--path-format=absolute", "--git-common-dir"], projectDir)
  const fromCommonDir = commonDir === undefined ? undefined : repoNameFromCommonDir(commonDir)
  if (fromCommonDir !== undefined) return fromCommonDir

  return basename(projectDir)
}

function resolveCommitSha(runGit: NonNullable<ResolveRepoOriginDeps["runGit"]>, projectDir: string): string {
  return readGit(runGit, ["rev-parse", "--short", "HEAD"], projectDir) ?? UNKNOWN_COMMIT_SHA
}

export function resolveRepoOrigin(projectDir: string, deps: ResolveRepoOriginDeps = {}): RepoOrigin {
  const runGit = deps.runGit ?? defaultRunGit
  return {
    repoName: resolveRepoName(runGit, projectDir),
    commitSha: resolveCommitSha(runGit, projectDir),
  }
}
