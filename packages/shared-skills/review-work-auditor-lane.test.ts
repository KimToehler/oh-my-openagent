import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const skillPath = join(import.meta.dir, "skills", "review-work", "SKILL.md")

describe("review-work Auditor lane", () => {
  test("passes full code-quality instructions to Auditor", () => {
    // given
    const skillText = readFileSync(skillPath, "utf8")

    // when
    const auditorInvocation = skillText.match(/task\(\n  subagent_type="auditor",[\s\S]*?\n\)/)?.[0]

    // then
    expect(auditorInvocation).toBeDefined()
    expect(auditorInvocation).toContain("<review_type>CODE QUALITY REVIEW</review_type>")
    expect(auditorInvocation).toContain("<blocking_issues>")
  })
})
