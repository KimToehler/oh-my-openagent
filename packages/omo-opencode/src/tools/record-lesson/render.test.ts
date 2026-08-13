import { parseRuleFrontmatter, shouldApplyRule } from "@oh-my-opencode/rules-engine"
import { describe, expect, test } from "bun:test"
import { computeLessonHash, computeSemanticLessonHash, extractBody, renderLesson, type RenderLessonInput } from "./render"

function createInput(overrides: Partial<RenderLessonInput> = {}): RenderLessonInput {
  return {
    description: "Lesson - new tool families must be config-gated in the registry",
    globs: ["packages/omo-opencode/src/plugin/**/*.ts"],
    title: "new tool families must be config-gated",
    repoName: "oh-my-openagent",
    commitSha: "a4b34ebe8",
    model: "anthropic/claude-opus-4-5",
    recordedDate: "2026-08-13",
    lessonId: "20260813-tool-registry-gating-a3f9c1",
    lessonHash: "4f2a9c1e77b03d58",
    whatWentWrong: "A new tool family was registered unconditionally.",
    ruleForNextTime: "Gate every new tool family behind a config flag.",
    citations: ["packages/omo-opencode/src/plugin/tool-registry-core-tools.ts:143"],
    ...overrides,
  }
}

function frontmatterKeys(rendered: string): string[] {
  const lines = rendered.split("\n")
  expect(lines[0]).toBe("---")
  const closing = lines.indexOf("---", 1)
  expect(closing).toBeGreaterThan(0)
  return lines
    .slice(1, closing)
    .map((line) => line.match(/^([A-Za-z][A-Za-z0-9_-]*):/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => match[1] ?? "")
}

describe("#given a lesson rendered for the rules injector", () => {
  test("#when the frontmatter is inspected #then it carries only description and globs", () => {
    // given
    const input = createInput()

    // when
    const rendered = renderLesson(input)

    // then
    expect(frontmatterKeys(rendered)).toEqual(["description", "globs"])
  })

  test("#when the artifact is scanned #then alwaysApply never appears", () => {
    // given
    const input = createInput({ globs: ["packages/**/*.ts", "docs/**/*.md"] })

    // when
    const rendered = renderLesson(input)

    // then
    expect(rendered).not.toContain("alwaysApply")
  })

  test("#when only the body reaches the model #then it carries origin, model, and hash provenance", () => {
    // given
    const input = createInput()

    // when
    const body = extractBody(renderLesson(input))

    // then
    expect(body).toContain("Learned in: oh-my-openagent @ a4b34ebe8")
    expect(body).toContain("Learned against model: anthropic/claude-opus-4-5")
    expect(body).toContain("Recorded: 2026-08-13")
    expect(body).toContain("Lesson id: 20260813-tool-registry-gating-a3f9c1")
    expect(body).toContain("Lesson hash: 4f2a9c1e77b03d58")
    expect(body).toContain("# Lesson: new tool families must be config-gated")
    expect(body).toContain("## What went wrong")
    expect(body).toContain("## Rule for next time")
  })

  test("#when several citations are supplied #then each renders as an evidence bullet in input order", () => {
    // given
    const citations = ["packages/a.ts:1", "packages/b.ts:22", "docs/guide/team-mode.md:5"]
    const input = createInput({ citations })

    // when
    const rendered = renderLesson(input)
    const evidence = rendered.slice(rendered.indexOf("## Evidence"))

    // then
    expect(evidence.trimEnd().split("\n").slice(1).filter(Boolean)).toEqual([
      "- packages/a.ts:1",
      "- packages/b.ts:22",
      "- docs/guide/team-mode.md:5",
    ])
  })

  test("#when multiple globs are supplied #then each is a quoted block sequence entry", () => {
    // given
    const input = createInput({ globs: ["packages/omo-opencode/src/**/*.ts", "docs/**/*.md"] })

    // when
    const rendered = renderLesson(input)

    // then
    expect(rendered).toContain('globs:\n  - "packages/omo-opencode/src/**/*.ts"\n  - "docs/**/*.md"\n')
  })
})

describe("#given the real rules-engine read path", () => {
  test("#when the artifact is parsed #then extractBody matches the parser body exactly", () => {
    // given
    const rendered = renderLesson(createInput())

    // when
    const parsed = parseRuleFrontmatter(rendered)

    // then
    expect(parsed.body).toBe(extractBody(rendered))
  })

  test("#when the parser reads the frontmatter #then description and globs survive and the rule matches its glob", () => {
    // given
    const rendered = renderLesson(createInput())

    // when
    const parsed = parseRuleFrontmatter(rendered)
    const match = shouldApplyRule(
      parsed.metadata,
      "/repo/packages/omo-opencode/src/plugin/tool-registry-core-tools.ts",
      "/repo",
    )

    // then
    expect(parsed.metadata.description).toBe("Lesson - new tool families must be config-gated in the registry")
    expect(parsed.metadata.globs).toEqual(["packages/omo-opencode/src/plugin/**/*.ts"])
    expect(parsed.metadata.alwaysApply).toBeUndefined()
    expect(match).toEqual({ applies: true, reason: "glob: packages/omo-opencode/src/plugin/**/*.ts" })
  })

  test("#when a lesson body contains a frontmatter delimiter line #then the artifact keeps it in the body untouched", () => {
    // given
    const input = createInput({ whatWentWrong: "The diff looked like this:\n---\nremoved the gate" })

    // when
    const rendered = renderLesson(input)
    const parsed = parseRuleFrontmatter(rendered)

    // then
    expect(frontmatterKeys(rendered)).toEqual(["description", "globs"])
    expect(parsed.body).toContain("The diff looked like this:\n---\nremoved the gate")
    expect(parsed.body).toBe(extractBody(rendered))
  })

  test("#when a description spans several lines #then it is collapsed so the frontmatter stays one key per line", () => {
    // given
    const input = createInput({ description: "Lesson about gating\nacross two lines" })

    // when
    const rendered = renderLesson(input)
    const parsed = parseRuleFrontmatter(rendered)

    // then
    expect(frontmatterKeys(rendered)).toEqual(["description", "globs"])
    expect(parsed.metadata.description).toBe("Lesson about gating across two lines")
  })
})

describe("#given lesson dedup by semantic content", () => {
  test("#when two lessons differ only by recorded date #then their semantic hash is identical", () => {
    // given
    const first = createInput({ recordedDate: "2026-08-13", commitSha: "a4b34ebe8", lessonId: "id-one" })
    const second = createInput({ recordedDate: "2027-01-02", commitSha: "deadbeef1", lessonId: "id-two" })

    // when
    const firstHash = computeSemanticLessonHash(first)
    const secondHash = computeSemanticLessonHash(second)

    // then
    expect(firstHash).toBe(secondHash)
    expect(firstHash).toMatch(/^[0-9a-f]{16}$/)
  })

  test("#when the rule text changes #then the semantic hash changes", () => {
    // given
    const original = createInput()
    const changed = createInput({ ruleForNextTime: "Gate every new tool family and pin it with a test." })

    // when
    const originalHash = computeSemanticLessonHash(original)
    const changedHash = computeSemanticLessonHash(changed)

    // then
    expect(originalHash).not.toBe(changedHash)
  })

  test("#when globs arrive in a different order #then the semantic hash stays stable", () => {
    // given
    const ascending = createInput({ globs: ["a/**/*.ts", "b/**/*.ts"] })
    const descending = createInput({ globs: ["b/**/*.ts", "a/**/*.ts"] })

    // when + then
    expect(computeSemanticLessonHash(ascending)).toBe(computeSemanticLessonHash(descending))
  })

  test("#when a body is hashed #then it is the sha256 hex prefix the rules engine uses", () => {
    // given
    const body = extractBody(renderLesson(createInput()))

    // when
    const hash = computeLessonHash(body)

    // then
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    expect(computeLessonHash(body)).toBe(hash)
    expect(computeLessonHash(`${body}extra`)).not.toBe(hash)
  })
})
