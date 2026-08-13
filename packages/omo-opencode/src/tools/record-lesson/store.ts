import {
  existsSync as nodeExistsSync,
  lstatSync as nodeLstatSync,
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSync,
  readdirSync as nodeReaddirSync,
  realpathSync as nodeRealpathSync,
  renameSync as nodeRenameSync,
  statSync as nodeStatSync,
  unlinkSync as nodeUnlinkSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs"
import { randomBytes } from "node:crypto"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export type StoreDeps = {
  readonly now?: () => Date
  readonly processId?: number
  readonly randomHex?: () => string
  readonly existsSync?: (path: string) => boolean
  readonly readdirSync?: (path: string) => string[]
  readonly readFileSync?: (path: string) => string
  readonly writeFileSync?: (path: string, content: string, options: { readonly flag: "wx" }) => void
  readonly mkdirSync?: (path: string, options?: { readonly recursive: true }) => unknown
  readonly lstatSync?: (path: string) => { readonly isSymbolicLink: () => boolean }
  readonly realpathSync?: (path: string) => string
  readonly renameSync?: (source: string, destination: string) => void
  readonly sleepSync?: (milliseconds: number) => void
  readonly statSync?: (path: string) => { readonly ino: number; readonly mtimeMs: number }
  readonly unlinkSync?: (path: string) => void
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
const ALLOCATION_ERROR = `Error: could not allocate a unique lesson id after ${MAX_WRITE_ATTEMPTS} attempts.`
const LESSON_HASH_LINE = /^Lesson hash: ([0-9a-f]{16})$/m

const LOCK_FILENAME = ".record-lesson.lock"
// Dedup scan plus one small exclusive write should finish in milliseconds. One minute tolerates slow disks and debugging.
const LOCK_STALE_AFTER_MS = 60_000
const LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const
const LOCK_SLEEP_VIEW = new Int32Array(new SharedArrayBuffer(4))

export type LockResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

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

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && Reflect.get(error, "code") === code
}

function defaultSleepSync(milliseconds: number): void {
  Atomics.wait(LOCK_SLEEP_VIEW, 0, 0, milliseconds)
}

function reclaimStaleLock(lockPath: string, deps: StoreDeps): void {
  const now = deps.now ?? (() => new Date())
  const processId = deps.processId ?? process.pid
  const randomHex = deps.randomHex ?? defaultRandomHex
  const renameSync = deps.renameSync ?? nodeRenameSync
  const statSync = deps.statSync ?? nodeStatSync
  const unlinkSync = deps.unlinkSync ?? nodeUnlinkSync

  let observedInode: number
  try {
    const observed = statSync(lockPath)
    if (now().getTime() - observed.mtimeMs <= LOCK_STALE_AFTER_MS) return
    observedInode = observed.ino
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return
    throw error
  }

  const quarantinePath = `${lockPath}.reclaim-${processId}-${randomHex().slice(0, 6).toLowerCase()}`
  try {
    renameSync(lockPath, quarantinePath)
  } catch (error) {
    if (isFileSystemError(error, "ENOENT") || isFileSystemError(error, "EEXIST")) return
    throw error
  }

  try {
    if (statSync(quarantinePath).ino === observedInode) unlinkSync(quarantinePath)
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error
  }
}

export function withLessonStoreLock<T>(
  lessonsDir: string,
  deps: StoreDeps,
  criticalSection: () => T,
): LockResult<T> {
  const mkdirSync = deps.mkdirSync ?? nodeMkdirSync
  const now = deps.now ?? (() => new Date())
  const processId = deps.processId ?? process.pid
  const sleepSync = deps.sleepSync ?? defaultSleepSync
  const writeFileSync = deps.writeFileSync ?? nodeWriteFileSync
  const unlinkSync = deps.unlinkSync ?? nodeUnlinkSync
  const lockPath = join(lessonsDir, LOCK_FILENAME)

  try {
    mkdirSync(lessonsDir, { recursive: true })
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }

  for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const createdAt = now().toISOString()
      writeFileSync(lockPath, `pid=${processId}\ncreated=${createdAt}\n`, { flag: "wx" })
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) return { ok: false, error: errorMessage(error) }
      try {
        reclaimStaleLock(lockPath, deps)
      } catch (reclaimError) {
        return { ok: false, error: errorMessage(reclaimError) }
      }
      const retryDelayMs = LOCK_RETRY_DELAYS_MS[attempt]
      if (retryDelayMs !== undefined) sleepSync(retryDelayMs)
      continue
    }

    try {
      return { ok: true, value: criticalSection() }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    } finally {
      unlinkSync(lockPath)
    }
  }

  return {
    ok: false,
    error: `Error: lesson store lock is busy after ${LOCK_RETRY_DELAYS_MS.length + 1} attempts: ${lockPath}`,
  }
}

export function writeLessonExclusive(args: WriteLessonExclusiveArgs): WriteResult {
  const deps = args.deps ?? {}
  const mkdirSync = deps.mkdirSync ?? nodeMkdirSync
  const lstatSync = deps.lstatSync ?? nodeLstatSync
  const realpathSync = deps.realpathSync ?? ((path: string) => nodeRealpathSync(path))
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
