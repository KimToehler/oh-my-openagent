import {
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSync,
  readdirSync as nodeReaddirSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs"
import { randomBytes } from "node:crypto"
import { join, resolve } from "node:path"

export type StoreDeps = {
  readonly now?: () => Date
  readonly randomHex?: () => string
  readonly existsSync?: (path: string) => boolean
  readonly readdirSync?: (path: string) => string[]
  readonly readFileSync?: (path: string) => string
  readonly writeFileSync?: (path: string, content: string, options: { readonly flag: "wx" }) => void
  readonly mkdirSync?: (path: string, options?: { readonly recursive: true }) => unknown
}

export type WriteResult =
  | { readonly ok: true; readonly lessonId: string; readonly path: string }
  | { readonly ok: false; readonly error: string }

export type WriteLessonExclusiveArgs = {
  readonly lessonsDir: string
  readonly content: string
  readonly slugSource: string
  readonly deps?: StoreDeps
}

const MAX_SLUG_LENGTH = 40
const MAX_WRITE_ATTEMPTS = 5
const ALLOCATION_ERROR = "Error: could not allocate a unique lesson id after 5 attempts."
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
  return error instanceof Error ? String(error) : String(error)
}

export function writeLessonExclusive(args: WriteLessonExclusiveArgs): WriteResult {
  const deps = args.deps ?? {}
  const mkdirSync = deps.mkdirSync ?? nodeMkdirSync
  const writeFileSync = deps.writeFileSync ?? nodeWriteFileSync

  try {
    mkdirSync(args.lessonsDir, { recursive: true })
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const lessonId = generateLessonId(args.slugSource, deps)
    const path = resolve(args.lessonsDir, `${lessonId}.md`)
    try {
      writeFileSync(path, args.content, { flag: "wx" })
      return { ok: true, lessonId, path }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return { ok: false, error: errorMessage(error) }
      }
    }
  }

  return { ok: false, error: ALLOCATION_ERROR }
}

export function listLessons(lessonsDir: string, deps: StoreDeps = {}): string[] {
  const existsSync = deps.existsSync ?? nodeExistsSync
  const readdirSync = deps.readdirSync ?? ((path: string) => nodeReaddirSync(path))
  try {
    if (!existsSync(lessonsDir)) return []
    return readdirSync(lessonsDir).filter((name) => name.endsWith(".md")).sort()
  } catch {
    return []
  }
}

export function findLessonByHash(lessonsDir: string, hash: string, deps: StoreDeps = {}): string | undefined {
  const readFileSync = deps.readFileSync ?? ((path: string) => nodeReadFileSync(path, "utf8"))
  for (const filename of listLessons(lessonsDir, deps)) {
    try {
      const match = LESSON_HASH_LINE.exec(readFileSync(join(lessonsDir, filename)))
      if (match?.[1] === hash) return filename
    } catch {
      continue
    }
  }
  return undefined
}
