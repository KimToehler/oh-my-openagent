import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from "node:fs"
import { join } from "node:path"

import { spawnSync } from "../../shared/bun-spawn-shim"

export type ParsedCitation =
  | { readonly form: "path"; readonly raw: string; readonly pathPart: string; readonly startLine?: number; readonly endLine?: number }
  | { readonly form: "evidence"; readonly raw: string; readonly pathPart: string }
  | { readonly form: "commit"; readonly raw: string; readonly sha: string }
  | { readonly form: "test"; readonly raw: string; readonly pathPart: string; readonly testName: string }
  | { readonly form: "unsafe"; readonly raw: string }
  | { readonly form: "unknown"; readonly raw: string }

export type VerifyCitationsDeps = {
  readonly existsSync?: (p: string) => boolean
  readonly readFileSync?: (p: string) => string
  readonly runGit?: (args: readonly string[], cwd: string) => { readonly exitCode: number }
}

export type ParseCitationDeps = {
  readonly pathExists?: (p: string) => boolean
}

export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly failed: string; readonly reason: string }

const EVIDENCE_PREFIX = ".omo/evidence/"
const SHA_RE = /^[0-9a-f]{7,40}$/
const PATH_RE = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/
const LINE_SUFFIX_RE = /^(?<pathPart>.+?)(?::(?<startLine>\d+)(?:(?:-|:)(?<endLine>\d+))?)?$/
const TEST_NAME_RE = /^[A-Za-z0-9 _.,:()#[\]{}+*/'"=-]+$/
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/

export const REASON_PATH_MISSING = "path does not exist"
export const REASON_LINE_INVALID = "invalid or missing line"
export const REASON_COMMIT_MISSING = "commit not found"
export const REASON_UNRECOGNIZED = "unrecognized citation form"
export const REASON_NOT_REPO_RELATIVE = "citation must be repo-relative"

function isUnsafe(raw: string): boolean {
  if (raw.startsWith("/") || raw.startsWith("\\")) return true
  if (WINDOWS_DRIVE_RE.test(raw)) return true
  if (raw.includes("\\")) return true
  return raw.split(/[/\\]/).includes("..")
}

function looksLikePath(candidate: string): boolean {
  return PATH_RE.test(candidate)
}

function parsePathWithLines(raw: string): ParsedCitation {
  const match = LINE_SUFFIX_RE.exec(raw)
  const pathPart = match?.groups?.pathPart
  if (pathPart === undefined || !looksLikePath(pathPart)) {
    return { form: "unknown", raw }
  }

  const startLineText = match?.groups?.startLine
  const endLineText = match?.groups?.endLine

  return {
    form: "path",
    raw,
    pathPart,
    startLine: startLineText === undefined ? undefined : Number(startLineText),
    endLine: endLineText === undefined ? undefined : Number(endLineText),
  }
}

export function parseCitation(raw: string, deps: ParseCitationDeps = {}): ParsedCitation {
  if (isUnsafe(raw)) {
    return { form: "unsafe", raw }
  }

  const testSeparator = raw.indexOf("::")
  if (testSeparator !== -1) {
    const pathPart = raw.slice(0, testSeparator)
    const testName = raw.slice(testSeparator + 2)
    if (looksLikePath(pathPart) && TEST_NAME_RE.test(testName)) {
      return { form: "test", raw, pathPart, testName }
    }
    return { form: "unknown", raw }
  }

  if (raw.startsWith(EVIDENCE_PREFIX)) {
    const pathPart = raw.slice(EVIDENCE_PREFIX.length)
    if (pathPart.length > 0 && PATH_RE.test(pathPart)) {
      return { form: "evidence", raw, pathPart: raw }
    }
    return { form: "unknown", raw }
  }

  if (SHA_RE.test(raw) && deps.pathExists?.(raw) !== true) {
    return { form: "commit", raw, sha: raw }
  }

  return parsePathWithLines(raw)
}

function defaultRunGit(args: readonly string[], cwd: string): { readonly exitCode: number } {
  const result = spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  return { exitCode: result.exitCode }
}

function verifyOne(
  parsed: ParsedCitation,
  repoRoot: string,
  deps: Required<VerifyCitationsDeps>,
): string | null {
  switch (parsed.form) {
    case "unsafe":
      return REASON_NOT_REPO_RELATIVE
    case "unknown":
      return REASON_UNRECOGNIZED
    case "commit":
      return deps.runGit(["cat-file", "-e", `${parsed.sha}^{commit}`], repoRoot).exitCode === 0
        ? null
        : REASON_COMMIT_MISSING
    case "path": {
      const absolutePath = join(repoRoot, parsed.pathPart)
      if (!deps.existsSync(absolutePath)) return REASON_PATH_MISSING
      if (parsed.startLine === undefined) return null
      let content: string
      try {
        content = deps.readFileSync(absolutePath)
      } catch {
        return REASON_LINE_INVALID
      }
      const lineCount = content.length === 0 ? 0 : content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0)
      if (!Number.isSafeInteger(parsed.startLine) || parsed.startLine < 1 || parsed.startLine > lineCount) {
        return REASON_LINE_INVALID
      }
      if (
        parsed.endLine !== undefined &&
        (!Number.isSafeInteger(parsed.endLine) || parsed.endLine < parsed.startLine || parsed.endLine > lineCount)
      ) {
        return REASON_LINE_INVALID
      }
      return null
    }
    case "evidence":
    case "test":
      return deps.existsSync(join(repoRoot, parsed.pathPart)) ? null : REASON_PATH_MISSING
  }
}

export function verifyCitations(
  citations: readonly string[],
  repoRoot: string,
  deps: VerifyCitationsDeps = {},
): VerifyResult {
  const resolved: Required<VerifyCitationsDeps> = {
    existsSync: deps.existsSync ?? nodeExistsSync,
    readFileSync: deps.readFileSync ?? ((path) => nodeReadFileSync(path, "utf8")),
    runGit: deps.runGit ?? defaultRunGit,
  }

  for (const citation of citations) {
    const reason = verifyOne(
      parseCitation(citation, { pathExists: (path) => resolved.existsSync(join(repoRoot, path)) }),
      repoRoot,
      resolved,
    )
    if (reason !== null) {
      return { ok: false, failed: citation, reason }
    }
  }

  return { ok: true }
}
