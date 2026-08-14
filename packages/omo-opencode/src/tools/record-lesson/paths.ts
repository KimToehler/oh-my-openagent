import { resolveHomeDir } from "@oh-my-opencode/omo-config-core"
import { join } from "node:path"

const LESSONS_RELATIVE_DIR = join(".omo", "rules", "lessons")

export type ResolveLessonsDirArgs = {
  readonly env?: Record<string, string | undefined>
  readonly config?: { readonly storage?: "user" | "project"; readonly directory?: string }
  readonly projectDir: string
}

export type ResolveLessonsDirResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string }

function readNonBlank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return value.trim().length > 0 ? value : undefined
}

export function resolveLessonsDir(args: ResolveLessonsDirArgs): ResolveLessonsDirResult {
  const env = args.env ?? {}

  const envOverride = readNonBlank(env.OMO_LESSONS_DIR)
  if (envOverride !== undefined) return { ok: true, path: envOverride }

  if (args.config?.directory !== undefined) {
    return { ok: false, error: "Error: lessons.directory is not supported. Use OMO_LESSONS_DIR for an explicit user-controlled override." }
  }

  if (args.config?.storage === "project") return { ok: true, path: join(args.projectDir, LESSONS_RELATIVE_DIR) }

  // Home precedence must match the config loader (`env.HOME ?? env.USERPROFILE ?? process.cwd()`)
  // so a sandboxed HOME redirects the lessons dir together with the config read.
  return { ok: true, path: join(resolveHomeDir(env), LESSONS_RELATIVE_DIR) }
}
