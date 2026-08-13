import { existsSync as nodeExistsSync, readdirSync as nodeReaddirSync } from "node:fs"
import picomatch from "picomatch"

export type ValidationResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

export type ValidateFileCountDeps = {
  readonly existsSync?: (p: string) => boolean
  readonly readdirSync?: (p: string) => string[]
}

const MIN_GLOBS = 1
const MAX_GLOBS = 8
const LESSON_EXTENSION = ".md"
const UNIVERSAL_GLOB_PROBE_GROUPS = [
  ["a.txt", "x/y/z.bin", "LICENSE", ".env", "deep/nested/thing.q", "Makefile"],
  ["a.txt", "x/y/z.bin", ".env", "deep/nested/thing.q"],
] as const
// Keep aligned with packages/rules-engine/src/matcher.ts PICOMATCH_OPTIONS.
const PICOMATCH_OPTIONS = { dot: true, bash: true } as const

/**
 * Best-effort typo guard for literal match-everything patterns. This is not a scope
 * boundary: rootless type globs intentionally apply across projects. Probe groups
 * cover common extensionless and dotted paths without rejecting useful type filters.
 */
function isUniversalGlob(glob: string): boolean {
  const matcher = picomatch(glob, PICOMATCH_OPTIONS)
  return UNIVERSAL_GLOB_PROBE_GROUPS.some((probes) => probes.every((path) => matcher(path)))
}

export function validateGlobs(globs: readonly string[]): ValidationResult {
  if (globs.length < MIN_GLOBS) {
    return {
      ok: false,
      error: `Error: globs is required (${MIN_GLOBS}-${MAX_GLOBS} entries). A lesson without globs would fire in every project.`,
    }
  }

  if (globs.length > MAX_GLOBS) {
    return { ok: false, error: `Error: too many globs (max ${MAX_GLOBS}).` }
  }

  for (const glob of globs) {
    const trimmed = glob.trim()

    if (trimmed.length === 0) {
      return { ok: false, error: "Error: empty glob entry." }
    }

    if (isUniversalGlob(trimmed)) {
      return {
        ok: false,
        error: `Error: universal glob rejected: ${trimmed}. Scope the lesson to the files it actually applies to.`,
      }
    }
  }

  return { ok: true }
}

export function validateBodySize(body: string, maxBodyChars: number): ValidationResult {
  if (body.trim().length === 0) {
    return { ok: false, error: "Error: lesson body is empty." }
  }

  if (body.length > maxBodyChars) {
    return { ok: false, error: `Error: lesson body too long (${body.length} chars, max ${maxBodyChars}). Shorten it.` }
  }

  return { ok: true }
}

/**
 * The cap rejects rather than evicts. Evicting an oldest lesson is silent knowledge
 * loss, and the lesson store is append-only with stable identifiers, so dropping a
 * file would break references to it. Rejecting hands the consolidate-or-delete
 * decision back to the agent that asked to write.
 */
export function validateFileCount(
  lessonsDir: string,
  maxFiles: number,
  deps: ValidateFileCountDeps = {},
): ValidationResult {
  const existsSync = deps.existsSync ?? nodeExistsSync
  const readdirSync = deps.readdirSync ?? nodeReaddirSync

  const count = existsSync(lessonsDir) ? countLessonFiles(readdirSync(lessonsDir)) : 0

  if (count >= maxFiles) {
    return {
      ok: false,
      error: `Error: lesson cap reached (${maxFiles} files). Consolidate or delete existing lessons before recording a new one.`,
    }
  }

  return { ok: true }
}

function countLessonFiles(entries: readonly string[]): number {
  return entries.filter((entry) => entry.endsWith(LESSON_EXTENSION)).length
}
