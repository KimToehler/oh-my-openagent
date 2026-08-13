import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import { verifyCitations } from "./citations"
import { resolveRepoOrigin, type RepoOrigin } from "./origin"
import { resolveLessonsDir } from "./paths"
import { computeSemanticLessonHash, extractBody, renderLesson, type RenderLessonInput } from "./render"
import { generateLessonId, writeLessonExclusive } from "./store"
import type { RecordLessonArgs, RecordLessonDeps } from "./types"
import { validateBodySize, validateFileCount, validateGlobs } from "./validation"

const DEFAULT_MAX_FILES = 200
const DEFAULT_MAX_BODY_CHARS = 3000
const MIN_CITATIONS = 1
const MAX_CITATIONS = 5

function recordedDate(deps: RecordLessonDeps): string {
  return (deps.now?.() ?? new Date()).toISOString().slice(0, 10)
}

function resolveOrigin(deps: RecordLessonDeps): RepoOrigin {
  const injectedRepoName = deps.getRepoName?.()
  const injectedCommitSha = deps.getCommitSha?.()
  if (injectedRepoName !== undefined && injectedCommitSha !== undefined) {
    return { repoName: injectedRepoName, commitSha: injectedCommitSha }
  }
  const resolved = resolveRepoOrigin(deps.projectDir)
  return {
    repoName: injectedRepoName ?? resolved.repoName,
    commitSha: injectedCommitSha ?? resolved.commitSha,
  }
}

function createRenderInput(args: RecordLessonArgs, deps: RecordLessonDeps, lessonId: string): RenderLessonInput {
  const origin = resolveOrigin(deps)
  const input = {
    description: args.description ?? args.title,
    globs: args.globs,
    title: args.title,
    repoName: origin.repoName,
    commitSha: origin.commitSha,
    model: deps.getModelId(),
    recordedDate: recordedDate(deps),
    lessonId,
    lessonHash: "",
    whatWentWrong: args.what_went_wrong,
    ruleForNextTime: args.rule_for_next_time,
    citations: args.citations,
  }
  return { ...input, lessonHash: computeSemanticLessonHash(input) }
}

async function executeRecordLesson(args: RecordLessonArgs, deps: RecordLessonDeps): Promise<string> {
  const normalizedArgs: RecordLessonArgs = { ...args, globs: args.globs.map((glob) => glob.trim()) }
  const lessonsDirResult = resolveLessonsDir({ env: deps.env, config: deps.config, projectDir: deps.projectDir })
  if (!lessonsDirResult.ok) return lessonsDirResult.error
  const lessonsDir = lessonsDirResult.path
  const globsResult = validateGlobs(normalizedArgs.globs)
  if (!globsResult.ok) return globsResult.error

  if (normalizedArgs.citations.length < MIN_CITATIONS) return `Error: citations is required (${MIN_CITATIONS}-${MAX_CITATIONS} entries).`
  if (normalizedArgs.citations.length > MAX_CITATIONS) return `Error: too many citations (max ${MAX_CITATIONS}).`

  const citationsResult = verifyCitations(normalizedArgs.citations, deps.projectDir, deps.citationDeps)
  if (!citationsResult.ok) {
    return `Error: unverifiable citation: ${citationsResult.failed} (${citationsResult.reason})`
  }

  const hashInput = createRenderInput(normalizedArgs, deps, "pending")
  const initialId = generateLessonId(normalizedArgs.title, hashInput.lessonHash, deps.storeDeps)
  const input = createRenderInput(normalizedArgs, deps, initialId)
  const rendered = renderLesson(input)
  const bodyResult = validateBodySize(extractBody(rendered), deps.config?.max_body_chars ?? DEFAULT_MAX_BODY_CHARS)
  if (!bodyResult.ok) return bodyResult.error

  // Cap checks can overshoot to 199+N under N concurrent distinct writes. Next call rejects the bounded overshoot.
  // Textually different near-duplicates remain separate because semantic hashing intentionally preserves meaningful text.
  const countResult = validateFileCount(lessonsDir, deps.config?.max_files ?? DEFAULT_MAX_FILES, deps.storeDeps)
  if (!countResult.ok) return countResult.error

  const writeResult = writeLessonExclusive({
    lessonsDir,
    content: rendered,
    slugSource: normalizedArgs.title,
    semanticHash: input.lessonHash,
    deps: deps.storeDeps,
  })
  if (!writeResult.ok) return writeResult.error
  if (writeResult.duplicate) return `Existing lesson ${writeResult.path}; duplicate no-op.`
  return `Recorded lesson ${writeResult.lessonId}\nPath: ${writeResult.path}\nApplies to future sessions, not the current one.`
}

export function createRecordLessonTool(deps: RecordLessonDeps): ToolDefinition {
  return tool({
    description: `Record a verified, scoped lesson for future sessions.

Use this after identifying a concrete mistake and a reusable rule. Rejected calls never write partial lesson artifacts. Concurrent distinct writes can temporarily exceed max_files by their bounded in-flight count; the next call rejects the overshoot. Textually different near-duplicate lessons remain separate.`,
    args: {
      title: tool.schema.string().describe("Short title naming the reusable lesson"),
      what_went_wrong: tool.schema.string().describe("Concrete account of the mistake or failed approach"),
      rule_for_next_time: tool.schema.string().describe("Specific rule future agents should follow"),
      globs: tool.schema.array(tool.schema.string()).min(1).max(8).describe("1-8 file globs describing where the lesson applies. Precise repo-root globs such as packages/<name>/src/**/*.ts are accepted. Rootless globs such as **/*.ts intentionally apply in every project with matching files. Literal match-everything patterns are rejected as a best-effort typo guard, not a security boundary."),
      citations: tool.schema.array(tool.schema.string()).min(1).max(5).describe("1-5 verifiable citations: repo-relative path optionally with :line, :start-end, or :start:end; .omo/evidence/<dir>; git sha; or <path>::<test name>. Path lines must exist. Test names allow conservative letters, numbers, spaces, and common test punctuation only. Unverifiable citations are rejected outright."),
      description: tool.schema.string().optional().describe("Frontmatter description; defaults to title when omitted"),
    },
    execute: async (args, _context) => executeRecordLesson(args, deps),
  })
}
