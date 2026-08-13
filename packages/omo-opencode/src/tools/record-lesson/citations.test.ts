import { describe, expect, test } from "bun:test"

import { parseCitation, verifyCitations, type VerifyCitationsDeps } from "./citations"

const REPO_ROOT = "/repo"

function createRunGitSpy(exitCode: number): {
  runGit: NonNullable<VerifyCitationsDeps["runGit"]>
  calls: string[][]
} {
  const calls: string[][] = []
  return {
    calls,
    runGit: (args) => {
      calls.push([...args])
      return { exitCode }
    },
  }
}

describe("parseCitation", () => {
  test("#given a repo-relative path with a single line #when parsed #then the form is path and the line suffix is stripped", () => {
    // given
    const raw = "packages/omo-opencode/src/plugin/tool-registry-core-tools.ts:143"

    // when
    const parsed = parseCitation(raw)

    // then
    expect(parsed).toEqual({
      form: "path",
      raw,
      pathPart: "packages/omo-opencode/src/plugin/tool-registry-core-tools.ts",
      startLine: 143,
      endLine: undefined,
    })
  })

  test("#given a repo-relative path with a line range #when parsed #then both range bounds are captured", () => {
    // given
    const raw = "src/x.ts:10-20"

    // when
    const parsed = parseCitation(raw)

    // then
    expect(parsed).toEqual({
      form: "path",
      raw,
      pathPart: "src/x.ts",
      startLine: 10,
      endLine: 20,
    })
  })

  test("#given an evidence directory reference #when parsed #then the form is evidence", () => {
    // given
    const raw = ".omo/evidence/20260812-record-lesson"

    // when
    const parsed = parseCitation(raw)

    // then
    expect(parsed).toEqual({ form: "evidence", raw, pathPart: ".omo/evidence/20260812-record-lesson" })
  })

  test("#given an evidence file reference #when parsed #then the whole reference is the verified path", () => {
    // given
    const raw = ".omo/evidence/20260812-record-lesson/qa.md"

    // when
    const parsed = parseCitation(raw)

    // then
    expect(parsed).toEqual({ form: "evidence", raw, pathPart: ".omo/evidence/20260812-record-lesson/qa.md" })
  })

  test("#given a git commit sha #when parsed #then the form is commit", () => {
    // given
    const raw = "a4b34ebe8"

    // when
    const parsed = parseCitation(raw)

    // then
    expect(parsed).toEqual({ form: "commit", raw, sha: "a4b34ebe8" })
  })

  test("#given a lowercase hex filename #when parsed #then path existence takes precedence over sha syntax", () => {
    // given
    const raw = "deadbeef"

    // when
    const parsed = parseCitation(raw, { pathExists: (candidate) => candidate === raw })

    // then
    expect(parsed).toEqual({ form: "path", raw, pathPart: raw, startLine: undefined, endLine: undefined })
  })

  test("#given a test id #when parsed #then the path half and the test name are split", () => {
    // given
    const raw = "packages/omo-opencode/src/tools/record-lesson/citations.test.ts::parseCitation"

    // when
    const parsed = parseCitation(raw)

    // then
    expect(parsed).toEqual({
      form: "test",
      raw,
      pathPart: "packages/omo-opencode/src/tools/record-lesson/citations.test.ts",
      testName: "parseCitation",
    })
  })

  test.each([
    ["src/x.test.ts::bad<name>"],
    ["src/x.test.ts::bad>name"],
    ["src/x.test.ts::bad\nname"],
    ["src/x.test.ts::name; injected"],
  ])("#given unsafe test name %p #when parsed #then the form is unknown", (raw) => {
    // when
    const parsed = parseCitation(raw)

    // then
    expect(parsed).toEqual({ form: "unknown", raw })
  })

  test("#given free prose #when parsed #then the form is unknown", () => {
    // given
    const raw = "we checked it and it looked fine"

    // when
    const parsed = parseCitation(raw)

    // then
    expect(parsed).toEqual({ form: "unknown", raw })
  })

  test("#given a traversal or absolute citation #when parsed #then the form is unsafe", () => {
    // given
    const traversal = "../../etc/passwd"
    const absolute = "/etc/passwd"
    const windowsDrive = "C:\\Windows\\system32"

    // when
    const parsedTraversal = parseCitation(traversal)
    const parsedAbsolute = parseCitation(absolute)
    const parsedWindowsDrive = parseCitation(windowsDrive)

    // then
    expect(parsedTraversal).toEqual({ form: "unsafe", raw: traversal })
    expect(parsedAbsolute).toEqual({ form: "unsafe", raw: absolute })
    expect(parsedWindowsDrive).toEqual({ form: "unsafe", raw: windowsDrive })
  })
})

describe("verifyCitations", () => {
  test("#given every citation resolves #when verified #then the result is ok", () => {
    // given
    const spy = createRunGitSpy(0)
    const citations = ["src/x.ts:10-20", ".omo/evidence/20260812-x/qa.md", "a4b34ebe8", "src/x.test.ts::does a thing"]

    // when
    const result = verifyCitations(citations, REPO_ROOT, {
      existsSync: () => true,
      readFileSync: () => Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"),
      runGit: spy.runGit,
    })

    // then
    expect(result).toEqual({ ok: true })
  })

  test("#given a path citation that does not exist #when verified #then it fails with path does not exist", () => {
    // given
    const citations = ["packages/does-not-exist.ts:12"]

    // when
    const result = verifyCitations(citations, REPO_ROOT, { existsSync: () => false, runGit: createRunGitSpy(0).runGit })

    // then
    expect(result).toEqual({ ok: false, failed: "packages/does-not-exist.ts:12", reason: "path does not exist" })
  })

  test("#given the production call shape without injected deps #when a missing line is verified #then it is rejected", () => {
    // given
    const citation = "package.json:999999"

    // when
    const result = verifyCitations([citation], process.cwd())

    // then
    expect(result).toEqual({ ok: false, failed: citation, reason: "invalid or missing line" })
  })

  test("#given a path citation with an existing line #when verified #then file line count is checked", () => {
    // given
    const checked: string[] = []

    // when
    const result = verifyCitations(["src/x.ts:3"], REPO_ROOT, {
      existsSync: (candidate) => {
        checked.push(candidate)
        return true
      },
      readFileSync: () => "one\ntwo\nthree\n",
      runGit: createRunGitSpy(0).runGit,
    })

    // then
    expect(result).toEqual({ ok: true })
    expect(checked).toEqual(["/repo/src/x.ts"])
  })

  test.each([["src/x.ts:999999"], ["src/x.ts:0"], ["src/x.ts:4-5"]])(
    "#given invalid or missing line citation %p #when verified #then it is rejected",
    (citation) => {
      // given
      const deps = {
        existsSync: () => true,
        readFileSync: () => "one\ntwo\nthree\n",
        runGit: createRunGitSpy(0).runGit,
      }

      // when
      const result = verifyCitations([citation], REPO_ROOT, deps)

      // then
      expect(result).toEqual({ ok: false, failed: citation, reason: "invalid or missing line" })
    },
  )

  test("#given a path line reader throws #when verified #then line verification fails closed", () => {
    // given
    const citation = "src/x.ts:1"

    // when
    const result = verifyCitations([citation], REPO_ROOT, {
      existsSync: () => true,
      readFileSync: () => {
        throw new Error("read failed")
      },
      runGit: createRunGitSpy(0).runGit,
    })

    // then
    expect(result).toEqual({ ok: false, failed: citation, reason: "invalid or missing line" })
  })

  test("#given exponential line syntax #when verified #then it is unrecognized rather than accepted as a path", () => {
    // given
    const citation = "src/x.ts:1e20"

    // when
    const result = verifyCitations([citation], REPO_ROOT, {
      existsSync: () => true,
      readFileSync: () => "one\ntwo\nthree\n",
      runGit: createRunGitSpy(0).runGit,
    })

    // then
    expect(result).toEqual({ ok: false, failed: citation, reason: "unrecognized citation form" })
  })

  test("#given common path start and end line form #when verified #then both existing lines are accepted", () => {
    // given
    const citation = "src/x.ts:2:3"

    // when
    const result = verifyCitations([citation], REPO_ROOT, {
      existsSync: () => true,
      readFileSync: () => "one\ntwo\nthree\n",
      runGit: createRunGitSpy(0).runGit,
    })

    // then
    expect(result).toEqual({ ok: true })
  })

  test("#given a test id citation #when verified #then only the path half is checked", () => {
    // given
    const checked: string[] = []

    // when
    const result = verifyCitations(["src/x.test.ts::does a thing"], REPO_ROOT, {
      existsSync: (candidate) => {
        checked.push(candidate)
        return true
      },
      runGit: createRunGitSpy(0).runGit,
    })

    // then
    expect(result).toEqual({ ok: true })
    expect(checked).toEqual(["/repo/src/x.test.ts"])
  })

  test("#given a sha that git cannot resolve #when verified #then it fails with commit not found", () => {
    // given
    const spy = createRunGitSpy(1)

    // when
    const result = verifyCitations(["deadbeefdeadbeef"], REPO_ROOT, { existsSync: () => false, runGit: spy.runGit })

    // then
    expect(result).toEqual({ ok: false, failed: "deadbeefdeadbeef", reason: "commit not found" })
    expect(spy.calls).toEqual([["cat-file", "-e", "deadbeefdeadbeef^{commit}"]])
  })

  test("#given an unrecognized citation #when verified #then it fails with unrecognized citation form", () => {
    // given
    const spy = createRunGitSpy(0)

    // when
    const result = verifyCitations(["we checked it and it looked fine"], REPO_ROOT, {
      existsSync: () => true,
      runGit: spy.runGit,
    })

    // then
    expect(result).toEqual({
      ok: false,
      failed: "we checked it and it looked fine",
      reason: "unrecognized citation form",
    })
    expect(spy.calls).toEqual([])
  })

  test("#given a traversal citation #when verified #then it fails as not repo-relative and git is never invoked", () => {
    // given
    const spy = createRunGitSpy(0)

    // when
    const result = verifyCitations(["../../etc/passwd"], REPO_ROOT, { existsSync: () => true, runGit: spy.runGit })

    // then
    expect(result).toEqual({ ok: false, failed: "../../etc/passwd", reason: "citation must be repo-relative" })
    expect(spy.calls).toEqual([])
  })

  test("#given an absolute citation #when verified #then it fails as not repo-relative and git is never invoked", () => {
    // given
    const spy = createRunGitSpy(0)

    // when
    const result = verifyCitations(["/etc/passwd"], REPO_ROOT, { existsSync: () => true, runGit: spy.runGit })

    // then
    expect(result).toEqual({ ok: false, failed: "/etc/passwd", reason: "citation must be repo-relative" })
    expect(spy.calls).toEqual([])
  })

  test("#given a good then bad then good list #when verified #then it names the bad one and stops checking", () => {
    // given
    const checked: string[] = []
    const existsSync = (candidate: string): boolean => {
      checked.push(candidate)
      return !candidate.includes("missing")
    }

    // when
    const result = verifyCitations(["src/first.ts", "src/missing.ts:4", "src/third.ts"], REPO_ROOT, { existsSync })

    // then
    expect(result).toEqual({ ok: false, failed: "src/missing.ts:4", reason: "path does not exist" })
    expect(checked).toEqual(["/repo/src/first.ts", "/repo/src/missing.ts"])
  })

  test("#given an empty citation list #when verified #then the result is ok", () => {
    // given
    const spy = createRunGitSpy(0)

    // when
    const result = verifyCitations([], REPO_ROOT, { existsSync: () => false, runGit: spy.runGit })

    // then
    expect(result).toEqual({ ok: true })
    expect(spy.calls).toEqual([])
  })
})
