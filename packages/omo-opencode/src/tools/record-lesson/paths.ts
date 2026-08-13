import { resolveHomeDir } from "@oh-my-opencode/omo-config-core"
import { join } from "node:path"

const LESSONS_RELATIVE_DIR = join(".omo", "rules", "lessons")

export type ResolveLessonsDirArgs = {
  readonly env?: Record<string, string | undefined>
  readonly config?: { readonly storage?: "user" | "project"; readonly directory?: string }
  readonly projectDir: string
}

function readNonBlank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return value.trim().length > 0 ? value : undefined
}

export function resolveLessonsDir(args: ResolveLessonsDirArgs): string {
  const env = args.env ?? {}

  const envOverride = readNonBlank(env.OMO_LESSONS_DIR)
  if (envOverride !== undefined) return envOverride

  const configuredDirectory = readNonBlank(args.config?.directory)
  if (configuredDirectory !== undefined) return configuredDirectory

  if (args.config?.storage === "project") return join(args.projectDir, LESSONS_RELATIVE_DIR)

  // Home precedence must match the config loader (`env.HOME ?? env.USERPROFILE ?? process.cwd()`)
  // so a sandboxed HOME redirects the lessons dir together with the config read.
  return join(resolveHomeDir(env), LESSONS_RELATIVE_DIR)
}
