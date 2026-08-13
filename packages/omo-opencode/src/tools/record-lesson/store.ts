import {
  existsSync as nodeExistsSync,
  lstatSync as nodeLstatSync,
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSync,
  readdirSync as nodeReaddirSync,
  realpathSync as nodeRealpathSync,
  unlinkSync as nodeUnlinkSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs"
import { randomBytes } from "node:crypto"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export type StoreDeps = {
  readonly now?: () => Date
  readonly randomHex?: () => string
  readonly existsSync?: (path: string) => boolean
  readonly readdirSync?: (path: string) => string[]
  readonly readFileSync?: (path: string) => string
  readonly writeFileSync?: (path: string, content: string, options: { readonly flag: "wx" }) => void
  readonly mkdirSync?: (path: string, options?: { readonly recursive: true }) => unknown
  readonly lstatSync?: (path: string) => { readonly isSymbolicLink: () => boolean }
  readonly realpathSync?: (path: string) => string
  readonly unlinkSync?: (path: string) => void
}

export type WriteResult =
  | { readonly ok: true; readonly lessonId: string; readonly path: string }
  | { readonly ok: false; readonly error: string }

export type WriteLessonExclusiveArgs = {
  readonly lessonsDir: string
  readonly content: string
  readonly slugSource: string
  readonly maxFiles?: number
  readonly deps?: StoreDeps
}

const MAX_SLUG_LENGTH = 40
const MAX_WRITE_ATTEMPTS = 5
const ALLOCATION_ERROR = `Error: could not allocate a unique lesson id after ${MAX_WRITE_ATTEMPTS} attempts.`
const LESSON_HASH_LINE = /^Lesson hash: ([0-9a-f]{16})$/m

function defaultRandomHex(): string {
  return randomBytes(3).toString("hex")
}

function normalizeSlug(source: string): string {
  const slug = source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, MAX_SLUG_LENGTH)
  return slug.replace(/-$/, "") || "lesson"
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "")
}

/** Lesson slugs are capped at 40 characters to keep filenames readable. */
export function generateLessonId(slugSource: string, deps: StoreDeps = {}): string {
  const now = deps.now ?? (() => new Date())
  const randomHex = deps.randomHex ?? defaultRandomHex
  return `${formatDate(now())}-${normalizeSlug(slugSource)}-${randomHex().slice(0, 6).toLowerCase()}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function capError(maxFiles: number): string {
  return `Error: lesson cap reached (${maxFiles} files). Consolidate or delete existing lessons before recording a new one.`
}

export function writeLessonExclusive(args: WriteLessonExclusiveArgs): WriteResult {
  const deps = args.deps ?? {}
  const mkdirSync = deps.mkdirSync ?? nodeMkdirSync
  const lstatSync = deps.lstatSync ?? nodeLstatSync
  const realpathSync = deps.realpathSync ?? ((path: string) => nodeRealpathSync(path))
  const unlinkSync = deps.unlinkSync ?? nodeUnlinkSync
  const writeFileSync = deps.writeFileSync ?? nodeWriteFileSync

  try {
    mkdirSync(args.lessonsDir, { recursive: true })
    if (lstatSync(args.lessonsDir).isSymbolicLink()) {
      return { ok: false, error: `Error: lessons directory must not be a symbolic link: ${args.lessonsDir}` }
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const lessonId = generateLessonId(args.slugSource, deps)
    const unresolvedPath = resolve(args.lessonsDir, `${lessonId}.md`)
    try {
      const lessonsRoot = realpathSync(args.lessonsDir)
      const resolvedParent = realpathSync(dirname(unresolvedPath))
      const path = resolve(resolvedParent, `${lessonId}.md`)
      const targetRelative = relative(lessonsRoot, path)
      if (targetRelative === ".." || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) {
        return { ok: false, error: `Error: lesson target escapes lessons directory: ${path}` }
      }

      writeFileSync(path, args.content, { flag: "wx" })
      if (args.maxFiles !== undefined && listLessons(lessonsRoot, deps).length > args.maxFiles) {
        unlinkSync(path)
        return { ok: false, error: capError(args.maxFiles) }
      }
      return { ok: true, lessonId, path }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        continue
      }
      return { ok: false, error: errorMessage(error) }
    }
  }

  return { ok: false, error: ALLOCATION_ERROR }
}

export function listLessons(lessonsDir: string, deps: StoreDeps = {}): string[] {
  const existsSync = deps.existsSync ?? nodeExistsSync
  const readdirSync = deps.readdirSync ?? ((path: string) => nodeReaddirSync(path))
  if (!existsSync(lessonsDir)) return []
  try {
    return readdirSync(lessonsDir).filter((name) => name.endsWith(".md")).sort()
  } catch (error) {
    throw new Error(`Failed to list lessons in ${lessonsDir}: ${errorMessage(error)}`)
  }
}

export function findLessonByHash(lessonsDir: string, hash: string, deps: StoreDeps = {}): string | undefined {
  const readFileSync = deps.readFileSync ?? ((path: string) => nodeReadFileSync(path, "utf8"))
  for (const filename of listLessons(lessonsDir, deps)) {
    const path = join(lessonsDir, filename)
    try {
      const match = LESSON_HASH_LINE.exec(readFileSync(path))
      if (match?.[1] === hash) return filename
    } catch (error) {
      throw new Error(`Failed to read lesson ${path}: ${errorMessage(error)}`)
    }
  }
  return undefined
}
