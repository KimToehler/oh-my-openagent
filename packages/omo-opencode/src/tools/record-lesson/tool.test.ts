import { describe, expect, test } from "bun:test"
import { basename, join } from "node:path"

import { createRecordLessonTool } from "./tool"
import type { StoreDeps } from "./store"

const FIXED_DATE = new Date("2026-08-13T00:00:00Z")
const LESSONS_DIR = "/lessons"
const VALID_ARGS = {
  title: "Gate new tool families",
  what_went_wrong: "A new tool family was registered unconditionally. ".repeat(10),
  rule_for_next_time: "Gate every new tool family behind a config flag. ".repeat(8),
  globs: ["src/plugin/**/*.ts", "src/tools/**/*.ts"],
  citations: ["packages/omo-opencode/src/plugin/tool-registry-core-tools.ts:143"],
}

function createMemoryFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const writes: string[] = []
  const deps: StoreDeps = {
    now: () => FIXED_DATE,
    randomHex: () => "111111",
    existsSync: (path) => files.has(path) || [...files.keys()].some((candidate) => candidate.startsWith(`${path}/`)),
    mkdirSync: () => undefined,
    readdirSync: (dir) => [...files.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1)),
    readFileSync: (path) => {
      const content = files.get(path)
      if (content === undefined) throw new Error(`missing file: ${path}`)
      return content
    },
    lstatSync: () => ({ isSymbolicLink: () => false }),
    realpathSync: (path) => path,
    unlinkSync: (path) => { files.delete(path) },
    writeFileSync: (path, content) => {
      writes.push(path)
      if (files.has(path)) {
        const error = new Error("file exists") as NodeJS.ErrnoException
        error.code = "EEXIST"
        throw error
      }
      files.set(path, content)
    },
  }
  return { files, writes, deps }
}

function createTool(memory: ReturnType<typeof createMemoryFs>, overrides = {}) {
  return createRecordLessonTool({
    projectDir: "/repo",
    env: { OMO_LESSONS_DIR: LESSONS_DIR },
    getModelId: () => "anthropic/claude-opus-4-5",
    getRepoName: () => "oh-my-openagent",
    getCommitSha: () => "65dcd0bef",
    now: () => FIXED_DATE,
    storeDeps: memory.deps,
    citationDeps: {
      existsSync: (path) => path.includes("tool-registry-core-tools.ts"),
      lstatSync: (path) => {
        if (!path.includes("tool-registry-core-tools.ts")) {
          const error = new Error(`ENOENT: no such file or directory, lstat '${path}'`) as NodeJS.ErrnoException
          error.code = "ENOENT"
          throw error
        }
        return { isFile: () => true, size: 2048 }
      },
      readFileSync: (path) => {
        if (!path.includes("tool-registry-core-tools.ts")) throw new Error(`missing file: ${path}`)
        return Array.from({ length: Number(VALID_ARGS.citations[0].split(":").at(-1)) }, (_, index) => `line ${index + 1}`).join("\n")
      },
    },
    ...overrides,
  })
}

async function execute(tool: ReturnType<typeof createRecordLessonTool>, args = VALID_ARGS): Promise<string> {
  return tool.execute(args, {} as never)
}

describe("createRecordLessonTool", () => {
  test("#given missing globs argument #when recording #then readable error names the field instead of throwing", async () => {
    // given
    const memory = createMemoryFs()
    const args = { ...VALID_ARGS, globs: undefined as never }

    // when
    const result = await execute(createTool(memory), args)

    // then
    expect(result).toStartWith("Error:")
    expect(result).toContain("globs")
    expect(result).not.toContain("undefined is not an object")
    expect(memory.files.size).toBe(0)
  })

  test("#given missing what_went_wrong argument #when recording #then readable error names the field instead of throwing", async () => {
    // given
    const memory = createMemoryFs()
    const args = { ...VALID_ARGS, what_went_wrong: undefined as never }

    // when
    const result = await execute(createTool(memory), args)

    // then
    expect(result).toStartWith("Error:")
    expect(result).toContain("what_went_wrong")
    expect(result).not.toContain("replaceAll")
    expect(memory.files.size).toBe(0)
  })

  test("#given missing rule_for_next_time argument #when recording #then readable error names the field instead of throwing", async () => {
    // given
    const memory = createMemoryFs()
    const args = { ...VALID_ARGS, rule_for_next_time: undefined as never }

    // when
    const result = await execute(createTool(memory), args)

    // then
    expect(result).toStartWith("Error:")
    expect(result).toContain("rule_for_next_time")
    expect(memory.files.size).toBe(0)
  })

  test("#given missing title argument #when recording #then readable error names the field instead of throwing", async () => {
    // given
    const memory = createMemoryFs()
    const args = { ...VALID_ARGS, title: undefined as never }

    // when
    const result = await execute(createTool(memory), args)

    // then
    expect(result).toStartWith("Error:")
    expect(result).toContain("title")
    expect(memory.files.size).toBe(0)
  })

  test("#given missing citations argument #when recording #then readable error names the field instead of throwing", async () => {
    // given
    const memory = createMemoryFs()
    const args = { ...VALID_ARGS, citations: undefined as never }

    // when
    const result = await execute(createTool(memory), args)

    // then
    expect(result).toStartWith("Error:")
    expect(result).toContain("citations")
    expect(memory.files.size).toBe(0)
  })

  test("#given valid lesson evidence #when recorded #then one scoped artifact is written and identified", async () => {
    // given
    const memory = createMemoryFs()

    // when
    const result = await execute(createTool(memory))

    // then
    expect(memory.files.size).toBe(1)
    const [path, content] = [...memory.files.entries()][0]!
    expect(result).toContain(basename(path, ".md"))
    expect(result).toContain(path)
    expect(content.match(/^---\n([\s\S]*?)\n---/m)?.[1]).toBe(`description: Gate new tool families\nglobs:\n  - "src/plugin/**/*.ts"\n  - "src/tools/**/*.ts"`)
    expect(content).toContain("Learned against model: anthropic/claude-opus-4-5")
    expect(content).toMatch(/Lesson hash: [0-9a-f]{16}/)
  })

  test("#given an unverifiable citation #when recording #then no filesystem residue is created", async () => {
    // given
    const memory = createMemoryFs({ "/lessons/existing.md": "existing" })
    const before = memory.files.size

    // when
    const result = await execute(createTool(memory), { ...VALID_ARGS, citations: ["packages/does-not-exist.ts:12"] })

    // then
    expect(result).toStartWith("Error: unverifiable citation:")
    expect(memory.files.size).toBe(before)
    expect(memory.writes).toEqual([])
  })

  test("#given a full lesson store #when recording #then cap error is returned without writing", async () => {
    // given
    const memory = createMemoryFs(Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`/lessons/${index}.md`, "x"])))

    // when
    const result = await execute(createTool(memory))

    // then
    expect(result).toBe("Error: lesson cap reached (200 files). Consolidate or delete existing lessons before recording a new one.")
    expect(memory.writes.filter((path) => path.endsWith(".md"))).toEqual([])
  })

  test("#given a body above the configured limit #when recording #then body error is returned without writing", async () => {
    // given
    const memory = createMemoryFs()

    // when
    const result = await execute(createTool(memory), { ...VALID_ARGS, what_went_wrong: "x".repeat(3100) })

    // then
    expect(result).toMatch(/^Error: lesson body too long \(\d+ chars, max 3000\)\. Shorten it\.$/)
    expect(memory.writes).toEqual([])
  })

  test("#given hash path has a different embedded hash #when recording #then collision suffix preserves filename and embedded id equality", async () => {
    // given
    const semanticPath = "/lessons/gate-new-tool-families-240345d0385f8cb5.md"
    const memory = createMemoryFs({ [semanticPath]: "Lesson hash: fedcba9876543210\nPREEXISTING" })
    memory.deps = { ...memory.deps, randomHex: () => "bbbbbb" }

    // when
    const result = await execute(createTool(memory))

    // then
    expect(result).toContain("bbbbbb")
    expect(memory.files.get(semanticPath)).toBe("Lesson hash: fedcba9876543210\nPREEXISTING")
    const [path, content] = [...memory.files.entries()].find(([path]) => path !== semanticPath)!
    expect(content).toContain(`Lesson id: ${basename(path, ".md")}`)
  })

  test("#given identical semantic content twice #when recorded twice #then second call is a duplicate no-op", async () => {
    // given
    const memory = createMemoryFs()
    const tool = createTool(memory)

    // when
    await execute(tool)
    const second = await execute(tool)

    // then
    expect(memory.files.size).toBe(1)
    expect(second).toContain("duplicate no-op")
    expect(second).toContain([...memory.files.keys()][0]!)
  })

  test("#given no origin deps #when recording from a worktree #then the origin line names the repo and a real sha", async () => {
    // given
    const memory = createMemoryFs()
    // Point at a subdirectory whose basename differs from the repo name, so the
    // assertion below proves the origin came from git rather than from the
    // directory name. Running from the repo root would make those two identical
    // and the check vacuous.
    const nestedDir = join(process.cwd(), "packages", "omo-opencode")
    const tool = createTool(memory, {
      projectDir: nestedDir,
      getRepoName: undefined,
      getCommitSha: undefined,
    })

    // when
    await execute(tool)

    // then
    const content = [...memory.files.values()][0]!
    const originLine = content.match(/^Learned in: (?<origin>.*)$/m)?.groups?.origin
    expect(originLine).toBeDefined()
    expect(originLine).not.toContain("unknown")
    expect(basename(nestedDir)).not.toBe("oh-my-openagent")
    expect(originLine).not.toContain(basename(nestedDir))
    expect(originLine).toMatch(/^oh-my-openagent @ [0-9a-f]{7,40}$/)
  })

  test("#given globs with surrounding whitespace #when recorded #then validation hashing and rendering use trimmed globs", async () => {
    // given
    const memory = createMemoryFs()

    // when
    await execute(createTool(memory), { ...VALID_ARGS, globs: ["  src/tools/**/*.ts  "] })

    // then
    const content = [...memory.files.values()][0]!
    expect(content).toContain('  - "src/tools/**/*.ts"')
    expect(content).not.toContain('  - "  src/tools/**/*.ts  "')
  })

  test("#given a duplicate on Windows-style storage #when recorded #then duplicate path uses platform join semantics", async () => {
    // given
    const memory = createMemoryFs()
    const tool = createTool(memory)
    await execute(tool)

    // when
    const result = await execute(tool)

    // then
    expect(result).toContain(`Existing lesson ${join(LESSONS_DIR, [...memory.files.keys()][0]!.slice(LESSONS_DIR.length + 1))}`)
  })

  test("#given a bad citation and full store #when recording #then citation rejection wins before cap validation", async () => {
    // given
    const memory = createMemoryFs(Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`/lessons/${index}.md`, "x"])))

    // when
    const result = await execute(createTool(memory), { ...VALID_ARGS, citations: ["packages/does-not-exist.ts:12"] })

    // then
    expect(result).toBe("Error: unverifiable citation: packages/does-not-exist.ts:12 (path does not exist)")
    expect(memory.writes).toEqual([])
  })
})
