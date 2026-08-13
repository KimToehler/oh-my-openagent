import { createContentHash } from "@oh-my-opencode/rules-engine"

export interface RenderLessonInput {
  /** Frontmatter only. The read path never shows this to the model. */
  readonly description: string
  readonly globs: readonly string[]
  readonly title: string
  readonly repoName: string
  readonly commitSha: string
  readonly model: string
  readonly recordedDate: string
  readonly lessonId: string
  readonly lessonHash: string
  readonly whatWentWrong: string
  readonly ruleForNextTime: string
  readonly citations: readonly string[]
}

const FRONTMATTER_DELIMITER = "---"

/**
 * Renders the lesson artifact consumed unchanged by the rules injector.
 * Frontmatter carries only the keys the matcher reads; every fact the model
 * needs lives in the body, because only the body is injected into context.
 */
export function renderLesson(input: RenderLessonInput): string {
  const normalized = normalizeRenderInput(input)
  return `${renderFrontmatter(normalized)}\n${renderBody(normalized)}`
}

/**
 * Returns the bytes the read path treats as body, matching parseRuleFrontmatter:
 * everything after the first closing delimiter line and its newline.
 */
export function extractBody(rendered: string): string {
  const content = rendered.startsWith("\uFEFF") ? rendered.slice(1) : rendered
  const openingLength = openingDelimiterLength(content)
  if (openingLength === 0) return content
  let lineStart = openingLength
  while (lineStart <= content.length) {
    const nextNewline = content.indexOf("\n", lineStart)
    const lineEnd = nextNewline === -1 ? content.length : nextNewline
    if (content.slice(lineStart, lineEnd).replace(/\r$/, "") === FRONTMATTER_DELIMITER) {
      return nextNewline === -1 ? "" : content.slice(nextNewline + 1)
    }
    if (nextNewline === -1) break
    lineStart = nextNewline + 1
  }
  return content
}

/** sha256 hex sliced to 16 chars, shared with the rules engine dedup cache. */
export function computeLessonHash(body: string): string {
  return createContentHash(body)
}

/**
 * Dedup key over semantic content only (title, both lesson sections, sorted globs),
 * never over the rendered body, because the body embeds the hash line itself.
 */
export function normalizeSemanticLessonTitle(title: string): string {
  return collapseToSingleLine(canonicalizeLessonText(title))
}

export function computeSemanticLessonHash(input: RenderLessonInput): string {
  const globs = [...new Set(input.globs.map((glob) => glob.trim()))].sort()
  return createContentHash(
    [
      normalizeSemanticLessonTitle(input.title),
      canonicalizeLessonText(input.whatWentWrong).trim(),
      canonicalizeLessonText(input.ruleForNextTime).trim(),
      ...globs,
    ].join("\n\u0000\n"),
  )
}

function renderFrontmatter(input: RenderLessonInput): string {
  const globs = input.globs.map((glob) => `  - ${JSON.stringify(glob)}`).join("\n")
  const lines = [FRONTMATTER_DELIMITER, `description: ${collapseToSingleLine(input.description)}`, "globs:"]
  if (globs.length > 0) lines.push(globs)
  lines.push(FRONTMATTER_DELIMITER)
  return `${lines.join("\n")}\n`
}

function renderBody(input: RenderLessonInput): string {
  const evidence = input.citations.map((citation) => `- ${collapseToSingleLine(citation)}`).join("\n")
  return [
    `# Lesson: ${collapseToSingleLine(input.title)}`,
    "",
    `Learned in: ${input.repoName} @ ${input.commitSha}`,
    `Learned against model: ${input.model}`,
    `Recorded: ${input.recordedDate}`,
    `Lesson id: ${input.lessonId}`,
    `Lesson hash: ${input.lessonHash}`,
    "",
    "## What went wrong",
    sanitizeLessonText(input.whatWentWrong),
    "",
    "## Rule for next time",
    sanitizeLessonText(input.ruleForNextTime),
    "",
    "## Evidence",
    evidence,
    "",
  ].join("\n")
}


/**
 * Normalizes every model-controlled string at the render boundary. Zero-width
 * separators preserve readable quoted syntax while making control markers inert.
 */
function normalizeRenderInput(input: RenderLessonInput): RenderLessonInput {
  return {
    description: collapseToSingleLine(sanitizeLessonText(input.description)),
    globs: input.globs.map((glob) => collapseToSingleLine(sanitizeLessonText(glob))),
    title: collapseToSingleLine(sanitizeLessonText(input.title)),
    repoName: collapseToSingleLine(sanitizeLessonText(input.repoName)),
    commitSha: collapseToSingleLine(sanitizeLessonText(input.commitSha)),
    model: collapseToSingleLine(sanitizeLessonText(input.model)),
    recordedDate: collapseToSingleLine(sanitizeLessonText(input.recordedDate)),
    lessonId: collapseToSingleLine(sanitizeLessonText(input.lessonId)),
    lessonHash: collapseToSingleLine(sanitizeLessonText(input.lessonHash)),
    whatWentWrong: sanitizeLessonText(input.whatWentWrong),
    ruleForNextTime: sanitizeLessonText(input.ruleForNextTime),
    citations: input.citations.map((citation) => collapseToSingleLine(sanitizeLessonText(citation))),
  }
}

function sanitizeLessonText(value: string): string {
  return canonicalizeLessonText(value)
    .trim()
    // Load-bearing: hydration requires `]\n[Match:` adjacency, so every line-anchored Match banner must stay inert.
    .replace(/^(\s*)\[(Rule|Match):/gm, "$1[\u200B$2:")
    .replace(/<(\/?)(system-reminder|rules)(?=[\s>])/gi, "<\u200B$1$2")
}

/** Hashing removes only separators inserted by sanitizeLessonText. */
function canonicalizeLessonText(value: string): string {
  return value.replaceAll("\u200B", "")
}

function collapseToSingleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function openingDelimiterLength(content: string): number {
  if (content.startsWith("---\r\n")) return 5
  if (content.startsWith("---\n")) return 4
  return 0
}
