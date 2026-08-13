import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const STORE_SOURCE = readFileSync(new URL("./store.ts", import.meta.url), "utf8")

import {
  generateLessonId,
  listLessons,
  writeLessonExclusive,
  type StoreDeps,
} from "./store"

const TEMP_DIRS: string[] = []

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "record-lesson-lock-"))
  TEMP_DIRS.push(dir)
  return dir
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      readFileSync(path)
      return
    } catch (error) {
      if (!(error instanceof Error) || Reflect.get(error, "code") !== "ENOENT") throw error
    }
    await Bun.sleep(5)
  }
  throw new Error(`timed out waiting for ${path}`)
}

function spawnLockProcess(script: string, args: readonly string[]): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, "-e", script, ...args], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  })
}

const FIXED_DATE = new Date("2026-08-13T00:00:00Z")

describe("lesson store lock audit", () => {
  test("#given store source #when audited #then blocking lockfile primitives cannot return", () => {
    // given
    const forbiddenPatterns = [/Atomics\.wait/, /const\s+\w*LOCK\w*FILENAME/i, /const\s+\w*STALE\w*(?:MS|THRESHOLD)/i]

    // when
    const violations = forbiddenPatterns.filter((pattern) => pattern.test(STORE_SOURCE))

    // then
    expect(violations).toEqual([])
  })
})

function createMemoryFs(initial: Record<string, string> = {}): {
  readonly deps: StoreDeps
  readonly files: Map<string, string>
  readonly writeAttempts: string[]
} {
  const files = new Map(Object.entries(initial))
  const writeAttempts: string[] = []
  const deps: StoreDeps = {
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
    writeFileSync: (path, content, options) => {
      writeAttempts.push(path)
      if (options.flag === "wx" && files.has(path)) {
        const error = new Error("file exists") as NodeJS.ErrnoException
        error.code = "EEXIST"
        throw error
      }
      files.set(path, content)
    },
  }
  return { deps, files, writeAttempts }
}

function sequence(values: readonly string[]): () => string {
  let index = 0
  return () => values[index++] ?? values.at(-1) ?? "000000"
}

describe("generateLessonId", () => {
  test("#given deterministic clock and randomness #when generated #then the id has the expected date slug and suffix", () => {
    // given
    const deps = { now: () => FIXED_DATE, randomHex: () => "a3f9c1" }

    // when
    const lessonId = generateLessonId("Tool Registry Gating", "0123456789abcdef", deps)

    // then
    expect(lessonId).toBe("tool-registry-gating-0123456789abcdef")
  })

  test("#given mixed case spaces and punctuation #when generated #then the slug is normalized and limited to 40 characters", () => {
    // given
    const source = "  Mixed CASE, punctuation!!! and a very long source name beyond forty chars  "

    // when
    const lessonId = generateLessonId(source, "0123456789abcdef", { now: () => FIXED_DATE, randomHex: () => "abcdef" })

    // then
    expect(lessonId).toBe("mixed-case-punctuation-and-a-very-long-s-0123456789abcdef")
  })

  test("#given truncation lands on a separator #when generated #then the slug has no dangling hyphen", () => {
    // given
    const source = `${"a".repeat(39)} tail`

    // when
    const lessonId = generateLessonId(source, "0123456789abcdef", { now: () => FIXED_DATE, randomHex: () => "abcdef" })

    // then
    expect(lessonId).toBe(`${"a".repeat(39)}-0123456789abcdef`)
  })

  test("#given a source with no alphanumeric characters #when generated #then the slug falls back to lesson", () => {
    // given
    const source = " !!! "

    // when
    const lessonId = generateLessonId(source, "0123456789abcdef", { now: () => FIXED_DATE, randomHex: () => "123abc" })

    // then
    expect(lessonId).toBe("lesson-0123456789abcdef")
  })
})

describe("listLessons", () => {
  test("#given markdown and non-markdown entries #when listed #then only markdown filenames are returned sorted", () => {
    // given
    const memory = createMemoryFs({ "/lessons/z.md": "z", "/lessons/notes.txt": "x", "/lessons/a.md": "a" })

    // when
    const lessons = listLessons("/lessons", memory.deps)

    // then
    expect(lessons).toEqual(["a.md", "z.md"])
  })

  test("#given a missing directory #when listed #then an empty array is returned", () => {
    // given
    const memory = createMemoryFs()

    // when
    const lessons = listLessons("/missing", memory.deps)

    // then
    expect(lessons).toEqual([])
  })
})

describe("multi-process lesson writes", () => {
  const runWorkers = async (lessonsDir: string, hashes: readonly string[]): Promise<readonly string[]> => {
    const startPath = join(lessonsDir, "start")
    const storeUrl = new URL("./store.ts", import.meta.url).href
    const script = `
      import { existsSync } from "node:fs";
      import { writeLessonExclusive } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
      const [lessonsDir, startPath, hash] = process.argv.slice(1);
      while (!existsSync(startPath)) await new Promise((resolve) => setTimeout(resolve, 2));
      const content = \`Lesson id: placeholder\\nLesson hash: \${hash}\\nRecorded: 2026-08-14\\n\`;
      const result = writeLessonExclusive({ lessonsDir, content, slugSource: \`Lesson \${hash}\`, semanticHash: hash });
      if (!result.ok) { console.error(result.error); process.exit(1); }
      console.log(result.duplicate ? "duplicate no-op" : "Recorded");
    `
    void storeUrl
    const workers = hashes.map((hash) => Bun.spawn([process.execPath, "-e", script, lessonsDir, startPath, hash], { stdout: "pipe", stderr: "pipe" }))
    writeFileSync(startPath, "go")
    return Promise.all(workers.map(async (worker) => {
      const output = await new Response(worker.stdout).text()
      const error = await new Response(worker.stderr).text()
      const exitCode = await worker.exited
      if (exitCode !== 0) throw new Error(error)
      return output.trim()
    }))
  }

  test("#given four processes recording one semantic lesson #when released together #then one records and three are duplicate no-ops", async () => {
    // given
    const lessonsDir = createTempDir()

    // when
    const outputs = await runWorkers(lessonsDir, Array.from({ length: 4 }, () => "0123456789abcdef"))

    // then
    expect(readdirSync(lessonsDir).filter((name) => name.endsWith(".md"))).toHaveLength(1)
    expect(outputs.filter((output) => output === "Recorded")).toHaveLength(1)
    expect(outputs.filter((output) => output === "duplicate no-op")).toHaveLength(3)
  })

  test("#given four processes recording distinct semantic lessons #when released together #then all four record without failure", async () => {
    // given
    const lessonsDir = createTempDir()
    const hashes = ["0000000000000001", "0000000000000002", "0000000000000003", "0000000000000004"]

    // when
    const outputs = await runWorkers(lessonsDir, hashes)

    // then
    expect(readdirSync(lessonsDir).filter((name) => name.endsWith(".md"))).toHaveLength(4)
    expect(outputs).toEqual(["Recorded", "Recorded", "Recorded", "Recorded"])
  })
})
