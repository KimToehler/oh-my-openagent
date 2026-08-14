import { randomBytes } from "node:crypto"
import {
  existsSync as nodeExistsSync,
  linkSync as nodeLinkSync,
  lstatSync as nodeLstatSync,
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSync,
  readdirSync as nodeReaddirSync,
  realpathSync as nodeRealpathSync,
  unlinkSync as nodeUnlinkSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { normalizeSemanticLessonTitle } from "./render"

export type StoreDeps = {
  readonly now?: () => Date
  readonly randomHex?: () => string
  readonly existsSync?: (path: string) => boolean
  readonly readdirSync?: (path: string) => string[]
  readonly readFileSync?: (path: string) => string
  readonly writeFileSync?: (path: string, content: string, options: { readonly flag: "wx" }) => void
  readonly mkdirSync?: (path: string, options?: { readonly recursive: true }) => unknown
  readonly linkSync?: (existingPath: string, newPath: string) => void
  readonly lstatSync?: (path: string) => { readonly isSymbolicLink: () => boolean }
  readonly realpathSync?: (path: string) => string
  readonly unlinkSync?: (path: string) => void
}

export type WriteResult =
  | { readonly ok: true; readonly duplicate: boolean; readonly lessonId: string; readonly path: string }
  | { readonly ok: false; readonly error: string }

export type WriteLessonExclusiveArgs = {
  readonly lessonsDir: string
  readonly content: string
  readonly slugSource: string
  readonly semanticHash: string
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

/** Semantic hash determines normal-path identity. Clock and randomness cannot change it. */
export function generateLessonId(slugSource: string, semanticHash: string, _deps: StoreDeps = {}): string {
  return `${normalizeSlug(normalizeSemanticLessonTitle(slugSource))}-${semanticHash}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && Reflect.get(error, "code") === code
}

function contentWithLessonId(content: string, lessonId: string): string {
  return content.replace(/^Lesson id: .*$/m, `Lesson id: ${lessonId}`)
}

function publishAtomically(
  tempPath: string,
  targetPath: string,
  content: string,
  writeFileSync: NonNullable<StoreDeps["writeFileSync"]>,
  linkSync: NonNullable<StoreDeps["linkSync"]>,
  unlinkSync: NonNullable<StoreDeps["unlinkSync"]>,
): void {
  try {
    writeFileSync(tempPath, content, { flag: "wx" })
  } catch (error) {
    if (!isFileSystemError(error, "EEXIST")) unlinkSync(tempPath)
    throw error
  }
  try {
    linkSync(tempPath, targetPath)
  } finally {
    unlinkSync(tempPath)
  }
}

export function writeLessonExclusive(args: WriteLessonExclusiveArgs): WriteResult {
  const deps = args.deps ?? {}
  const mkdirSync = deps.mkdirSync ?? nodeMkdirSync
  const lstatSync = deps.lstatSync ?? nodeLstatSync
  const readFileSync = deps.readFileSync ?? ((path: string) => nodeReadFileSync(path, "utf8"))
  const realpathSync = deps.realpathSync ?? ((path: string) => nodeRealpathSync(path))
  const randomHex = deps.randomHex ?? defaultRandomHex
  const unlinkSync = deps.unlinkSync ?? nodeUnlinkSync
  const writeFileSync = deps.writeFileSync ?? nodeWriteFileSync
  const linkSync = deps.linkSync ?? (deps.writeFileSync === undefined
    ? nodeLinkSync
    : (existingPath: string, newPath: string) => writeFileSync(newPath, readFileSync(existingPath), { flag: "wx" }))

  try {
    mkdirSync(args.lessonsDir, { recursive: true })
    if (lstatSync(args.lessonsDir).isSymbolicLink()) {
      return { ok: false, error: `Error: lessons directory must not be a symbolic link: ${args.lessonsDir}` }
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }

  const baseLessonId = generateLessonId(args.slugSource, args.semanticHash, deps)
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const lessonId = attempt === 0 ? baseLessonId : `${baseLessonId}-${randomHex().slice(0, 6).toLowerCase()}`
    const unresolvedPath = resolve(args.lessonsDir, `${lessonId}.md`)
    let path = unresolvedPath
    try {
      const lessonsRoot = realpathSync(args.lessonsDir)
      const resolvedParent = realpathSync(dirname(unresolvedPath))
      path = resolve(resolvedParent, `${lessonId}.md`)
      const targetRelative = relative(lessonsRoot, path)
      if (targetRelative === ".." || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) {
        return { ok: false, error: `Error: lesson target escapes lessons directory: ${path}` }
      }

      const tempPath = resolve(resolvedParent, `.${lessonId}.${randomHex()}.tmp`)
      publishAtomically(tempPath, path, contentWithLessonId(args.content, lessonId), writeFileSync, linkSync, unlinkSync)
      return { ok: true, duplicate: false, lessonId, path }
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) return { ok: false, error: errorMessage(error) }
      try {
        const existingHash = LESSON_HASH_LINE.exec(readFileSync(path))?.[1]
        if (existingHash === undefined) {
          return { ok: false, error: `Error: existing lesson has no parsable Lesson hash: line: ${path}` }
        }
        if (existingHash === args.semanticHash) {
          return { ok: true, duplicate: true, lessonId, path }
        }
      } catch (readError) {
        return { ok: false, error: errorMessage(readError) }
      }
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
