import { describe, expect, test } from "bun:test"

import { validateBodySize, validateFileCount, validateGlobs, type ValidateFileCountDeps } from "./validation"

const LESSONS_DIR = "/home/user/.omo/rules/lessons"

function createLessonsDirDeps(entries: readonly string[], exists = true): ValidateFileCountDeps {
  return {
    existsSync: () => exists,
    readdirSync: () => [...entries],
  }
}

function createMarkdownEntries(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `lesson-${index}.md`)
}

describe("validateGlobs", () => {
  test("#given a single scoped glob #when validated #then the result is ok", () => {
    // given
    const globs = ["src/tools/**/*.ts"]

    // when
    const result = validateGlobs(globs)

    // then
    expect(result).toEqual({ ok: true })
  })

  test("#given exactly eight scoped globs #when validated #then the result is ok", () => {
    // given
    const globs = Array.from({ length: 8 }, (_, index) => `src/area-${index}/**/*.ts`)

    // when
    const result = validateGlobs(globs)

    // then
    expect(result).toEqual({ ok: true })
  })

  test("#given nine globs #when validated #then it fails with the max eight message", () => {
    // given
    const globs = Array.from({ length: 9 }, (_, index) => `packages/pkg-${index}/src/**/*.ts`)

    // when
    const result = validateGlobs(globs)

    // then
    expect(result).toEqual({ ok: false, error: "Error: too many globs (max 8)." })
  })

  test("#given no globs #when validated #then it fails because a lesson without globs fires everywhere", () => {
    // given
    const globs: readonly string[] = []

    // when
    const result = validateGlobs(globs)

    // then
    expect(result).toEqual({
      ok: false,
      error: "Error: globs is required (1-8 entries). A lesson without globs would fire in every project.",
    })
  })

  test.each([["*"], ["**"], ["**/*"], ["**/*.*"], ["./**"], ["**/**"], ["{,**/}*"], ["?*"], ["**/?*"], ["**/*?"]])(
    "#given the universal glob %p #when validated #then it is rejected and the message names it",
    (glob) => {
      // given
      const globs = [glob]

      // when
      const result = validateGlobs(globs)

      // then
      expect(result).toEqual({
        ok: false,
        error: `Error: universal glob rejected: ${glob}. Scope the lesson to the files it actually applies to.`,
      })
    },
  )

  test.each([["src/**/*.ts"], ["**/*.test.ts"], ["docs/**"]])(
    "#given the scoped glob %p #when validated #then it is accepted",
    (glob) => {
      // given
      const globs = [glob]

      // when
      const result = validateGlobs(globs)

      // then
      expect(result).toEqual({ ok: true })
    },
  )

  test.each([
    ["packages/omo-opencode/src/plugin/**/*.ts"],
    ["apps/web/src/**/*.ts"],
    ["libs/core/**/*.ts"],
    ["crates/runtime/src/**/*.rs"],
    ["services/api/**/*.go"],
  ])("#given a precise repo-root glob %p #when validated #then it is accepted", (glob) => {
    // given
    const globs = [glob]

    // when
    const result = validateGlobs(globs)

    // then
    expect(result).toEqual({ ok: true })
  })

  test.each([["src/plugin/**/*.ts"], ["**/*.ts"], ["*.md"], ["**/*.{ts,tsx}"], ["*/**"], ["[a-z]*"], ["[!x]*"], ["**/*[!z]"], ["**/.*"]])(
    "#given the non-literal-match-everything glob %p #when validated #then it is accepted",
    (glob) => {
      // given
      const globs = [glob]

      // when
      const result = validateGlobs(globs)

      // then
      expect(result).toEqual({ ok: true })
    },
  )

  test("#given a universal glob padded with whitespace #when validated #then it is still rejected", () => {
    // given
    const globs = ["  **/*  "]

    // when
    const result = validateGlobs(globs)

    // then
    expect(result).toEqual({
      ok: false,
      error: "Error: universal glob rejected: **/*. Scope the lesson to the files it actually applies to.",
    })
  })

  test("#given a scoped glob that contains a double star #when validated #then it is accepted", () => {
    // given
    const globs = ["src/plugin/**/*.ts"]

    // when
    const result = validateGlobs(globs)

    // then
    expect(result).toEqual({ ok: true })
  })

  test("#given a scoped glob ending in a bare double star #when validated #then it is accepted", () => {
    // given
    const globs = ["src/plugin/**"]

    // when
    const result = validateGlobs(globs)

    // then
    expect(result).toEqual({ ok: true })
  })

  test("#given a blank glob entry #when validated #then it fails with the empty entry message", () => {
    // given
    const globs = ["src/**/*.ts", "   "]

    // when
    const result = validateGlobs(globs)

    // then
    expect(result).toEqual({ ok: false, error: "Error: empty glob entry." })
  })

  test("#given a universal glob among scoped globs #when validated #then the universal one is named", () => {
    // given
    const globs = ["src/**/*.ts", "**", "docs/**/*.md"]

    // when
    const result = validateGlobs(globs)

    // then
    expect(result).toEqual({
      ok: false,
      error: "Error: universal glob rejected: **. Scope the lesson to the files it actually applies to.",
    })
  })
})

describe("validateBodySize", () => {
  test("#given a body exactly at the limit #when validated #then the result is ok", () => {
    // given
    const body = "x".repeat(3000)

    // when
    const result = validateBodySize(body, 3000)

    // then
    expect(result).toEqual({ ok: true })
  })

  test("#given a body one char over the limit #when validated #then the message reports the actual length", () => {
    // given
    const body = "x".repeat(3001)

    // when
    const result = validateBodySize(body, 3000)

    // then
    expect(result).toEqual({ ok: false, error: "Error: lesson body too long (3001 chars, max 3000). Shorten it." })
  })

  test("#given an empty body #when validated #then it fails with the empty body message", () => {
    // given
    const body = ""

    // when
    const result = validateBodySize(body, 3000)

    // then
    expect(result).toEqual({ ok: false, error: "Error: lesson body is empty." })
  })

  test("#given a whitespace-only body #when validated #then it fails with the empty body message", () => {
    // given
    const body = "  \n\t  "

    // when
    const result = validateBodySize(body, 3000)

    // then
    expect(result).toEqual({ ok: false, error: "Error: lesson body is empty." })
  })
})

describe("validateFileCount", () => {
  test("#given the lessons dir does not exist #when validated #then the count is zero and the result is ok", () => {
    // given
    const deps: ValidateFileCountDeps = {
      existsSync: () => false,
      readdirSync: () => {
        throw new Error("readdirSync must not run when the dir is missing")
      },
    }

    // when
    const result = validateFileCount(LESSONS_DIR, 200, deps)

    // then
    expect(result).toEqual({ ok: true })
  })

  test("#given one lesson below the cap #when validated #then the result is ok", () => {
    // given
    const deps = createLessonsDirDeps(createMarkdownEntries(199))

    // when
    const result = validateFileCount(LESSONS_DIR, 200, deps)

    // then
    expect(result).toEqual({ ok: true })
  })

  test("#given the lesson count equals the cap #when validated #then it fails with the cap reached message", () => {
    // given
    const deps = createLessonsDirDeps(createMarkdownEntries(200))

    // when
    const result = validateFileCount(LESSONS_DIR, 200, deps)

    // then
    expect(result).toEqual({
      ok: false,
      error:
        "Error: lesson cap reached (200 files). Consolidate or delete existing lessons before recording a new one.",
    })
  })

  test("#given the lesson count exceeds the cap #when validated #then it fails with the cap reached message", () => {
    // given
    const deps = createLessonsDirDeps(createMarkdownEntries(201))

    // when
    const result = validateFileCount(LESSONS_DIR, 200, deps)

    // then
    expect(result).toEqual({
      ok: false,
      error:
        "Error: lesson cap reached (200 files). Consolidate or delete existing lessons before recording a new one.",
    })
  })

  test("#given non markdown files beside the lessons #when validated #then only markdown files count", () => {
    // given
    const deps = createLessonsDirDeps([...createMarkdownEntries(199), "README.txt", "notes.json", ".gitkeep"])

    // when
    const result = validateFileCount(LESSONS_DIR, 200, deps)

    // then
    expect(result).toEqual({ ok: true })
  })

  test("#given the lessons dir is read #when validated #then the configured dir is the one inspected", () => {
    // given
    const inspected: string[] = []

    // when
    const result = validateFileCount(LESSONS_DIR, 200, {
      existsSync: (candidate) => {
        inspected.push(candidate)
        return true
      },
      readdirSync: (candidate) => {
        inspected.push(candidate)
        return createMarkdownEntries(1)
      },
    })

    // then
    expect(result).toEqual({ ok: true })
    expect(inspected).toEqual([LESSONS_DIR, LESSONS_DIR])
  })
})
