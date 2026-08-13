import type { VerifyCitationsDeps } from "./citations"
import type { StoreDeps } from "./store"

export type RecordLessonConfig = {
  readonly storage?: "user" | "project"
  readonly directory?: string
  readonly max_files?: number
  readonly max_body_chars?: number
}

export type RecordLessonDeps = {
  readonly projectDir: string
  readonly config?: RecordLessonConfig
  readonly env?: Record<string, string | undefined>
  readonly getModelId: () => string
  readonly getRepoName?: () => string
  readonly getCommitSha?: () => string
  readonly now?: () => Date
  readonly storeDeps?: StoreDeps
  readonly citationDeps?: VerifyCitationsDeps
}

export type RecordLessonArgs = {
  readonly title: string
  readonly what_went_wrong: string
  readonly rule_for_next_time: string
  readonly globs: readonly string[]
  readonly citations: readonly string[]
  readonly description?: string
}
