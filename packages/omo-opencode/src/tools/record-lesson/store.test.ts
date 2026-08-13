import { describe, expect, test } from "bun:test"

import {
  findLessonByHash,
  generateLessonId,
  listLessons,
  withLessonStoreLock,
  writeLessonExclusive,
  type StoreDeps,
} from "./store"

const FIXED_DATE = new Date("2026-08-13T00:00:00Z")

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
    const lessonId = generateLessonId("Tool Registry Gating", deps)

    // then
    expect(lessonId).toBe("20260813-tool-registry-gating-a3f9c1")
  })

  test("#given mixed case spaces and punctuation #when generated #then the slug is normalized and limited to 40 characters", () => {
    // given
    const source = "  Mixed CASE, punctuation!!! and a very long source name beyond forty chars  "

    // when
    const lessonId = generateLessonId(source, { now: () => FIXED_DATE, randomHex: () => "abcdef" })

    // then
    expect(lessonId).toBe("20260813-mixed-case-punctuation-and-a-very-long-s-abcdef")
  })

  test("#given truncation lands on a separator #when generated #then the slug has no dangling hyphen", () => {
    // given
    const source = `${"a".repeat(39)} tail`

    // when
    const lessonId = generateLessonId(source, { now: () => FIXED_DATE, randomHex: () => "abcdef" })

    // then
    expect(lessonId).toBe(`20260813-${"a".repeat(39)}-abcdef`)
  })

  test("#given a source with no alphanumeric characters #when generated #then the slug falls back to lesson", () => {
    // given
    const source = " !!! "

    // when
    const lessonId = generateLessonId(source, { now: () => FIXED_DATE, randomHex: () => "123abc" })

    // then
    expect(lessonId).toBe("20260813-lesson-123abc")
  })
})

describe("writeLessonExclusive", () => {
  test("#given an unused id #when written #then exactly one file contains the exact content", () => {
    // given
    const memory = createMemoryFs()

    // when
    const result = writeLessonExclusive({
      lessonsDir: "/lessons",
      content: "exact content",
      slugSource: "Store",
      deps: { ...memory.deps, now: () => FIXED_DATE, randomHex: () => "111111" },
    })

    // then
    expect(result).toEqual({ ok: true, lessonId: "20260813-store-111111", path: "/lessons/20260813-store-111111.md" })
    expect([...memory.files.entries()]).toEqual([["/lessons/20260813-store-111111.md", "exact content"]])
  })

  test("#given the first id already exists #when written #then retry creates one different file without changing the existing bytes", () => {
    // given
    const existingPath = "/lessons/20260813-store-aaaaaa.md"
    const memory = createMemoryFs({ [existingPath]: "PREEXISTING" })

    // when
    const result = writeLessonExclusive({
      lessonsDir: "/lessons",
      content: "NEW CONTENT",
      slugSource: "Store",
      deps: { ...memory.deps, now: () => FIXED_DATE, randomHex: sequence(["aaaaaa", "bbbbbb"]) },
    })

    // then
    expect(result).toEqual({ ok: true, lessonId: "20260813-store-bbbbbb", path: "/lessons/20260813-store-bbbbbb.md" })
    expect(memory.writeAttempts).toEqual([existingPath, "/lessons/20260813-store-bbbbbb.md"])
    expect(memory.files.size).toBe(2)
    expect(memory.files.get(existingPath)).toBe("PREEXISTING")
  })

  test("#given five colliding ids #when written #then allocation fails without writing a file", () => {
    // given
    const initial = Object.fromEntries(["111111", "222222", "333333", "444444", "555555"].map((suffix) => [`/lessons/20260813-store-${suffix}.md`, suffix]))
    const memory = createMemoryFs(initial)

    // when
    const result = writeLessonExclusive({
      lessonsDir: "/lessons",
      content: "NEW CONTENT",
      slugSource: "Store",
      deps: { ...memory.deps, now: () => FIXED_DATE, randomHex: sequence(["111111", "222222", "333333", "444444", "555555"]) },
    })

    // then
    expect(result).toEqual({ ok: false, error: "Error: could not allocate a unique lesson id after 5 attempts." })
    expect(memory.files).toEqual(new Map(Object.entries(initial)))
  })

  test("#given a non-collision filesystem error #when written #then the real error message is returned without throwing", () => {
    // given
    const error = new Error("permission denied") as NodeJS.ErrnoException
    error.code = "EACCES"

    // when
    const result = writeLessonExclusive({
      lessonsDir: "/lessons",
      content: "content",
      slugSource: "Store",
      deps: {
        mkdirSync: () => undefined,
        lstatSync: () => ({ isSymbolicLink: () => false }),
        realpathSync: (path) => path,
        writeFileSync: () => { throw error },
        now: () => FIXED_DATE,
        randomHex: () => "111111",
      },
    })

    // then
    expect(result).toEqual({ ok: false, error: "permission denied" })
  })

  test("#given a symlinked lessons directory #when written #then the write boundary rejects it", () => {
    // given
    const memory = createMemoryFs()

    // when
    const result = writeLessonExclusive({
      lessonsDir: "/lessons",
      content: "content",
      slugSource: "Store",
      deps: {
        ...memory.deps,
        lstatSync: () => ({ isSymbolicLink: () => true }),
        now: () => FIXED_DATE,
        randomHex: () => "111111",
      },
    })

    // then
    expect(result).toEqual({ ok: false, error: "Error: lessons directory must not be a symbolic link: /lessons" })
    expect(memory.writeAttempts).toEqual([])
  })

  test("#given a resolved parent outside the lessons root #when written #then the escaping target is rejected", () => {
    // given
    const memory = createMemoryFs()
    let realpathCalls = 0

    // when
    const result = writeLessonExclusive({
      lessonsDir: "/safe/lessons",
      content: "content",
      slugSource: "Store",
      deps: {
        ...memory.deps,
        lstatSync: () => ({ isSymbolicLink: () => false }),
        realpathSync: () => realpathCalls++ === 0 ? "/safe/lessons" : "/safe/lessons-escape",
        now: () => FIXED_DATE,
        randomHex: () => "111111",
      },
    })

    // then
    expect(result).toEqual({ ok: false, error: "Error: lesson target escapes lessons directory: /safe/lessons-escape/20260813-store-111111.md" })
    expect(memory.writeAttempts).toEqual([])
  })

})

describe("withLessonStoreLock", () => {
  test("#given lock contention #when the critical section runs #then acquisition retries before entering", () => {
    // given
    const events: string[] = []
    let attempts = 0
    const deps: StoreDeps = {
      mkdirSync: () => undefined,
      writeFileSync: () => {
        attempts += 1
        events.push(`acquire-${attempts}`)
        if (attempts === 1) {
          const error = new Error("lock exists") as NodeJS.ErrnoException
          error.code = "EEXIST"
          throw error
        }
      },
      unlinkSync: () => { events.push("release") },
    }

    // when
    const result = withLessonStoreLock("/lessons", deps, () => {
      events.push("critical")
      return "done"
    })

    // then
    expect(result).toEqual({ ok: true, value: "done" })
    expect(events).toEqual(["acquire-1", "acquire-2", "critical", "release"])
  })

  test("#given a critical section error #when the lock scope exits #then the lock is removed", () => {
    // given
    const removed: string[] = []
    const deps: StoreDeps = {
      mkdirSync: () => undefined,
      writeFileSync: () => undefined,
      unlinkSync: (path) => { removed.push(path) },
    }

    // when
    const result = withLessonStoreLock("/lessons", deps, () => { throw new Error("dedup read failed") })

    // then
    expect(result).toEqual({ ok: false, error: "dedup read failed" })
    expect(removed).toEqual(["/lessons/.record-lesson.lock"])
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

describe("findLessonByHash", () => {
  test("#given a hash line and the same token in prose #when searched #then only the hash line matches", () => {
    // given
    const hash = "0123456789abcdef"
    const memory = createMemoryFs({
      "/lessons/a.md": `# Lesson\n\nProse mentions ${hash} but is not metadata.\n`,
      "/lessons/b.md": `# Lesson\n\nLesson hash: ${hash}\n`,
    })

    // when
    const match = findLessonByHash("/lessons", hash, memory.deps)

    // then
    expect(match).toBe("b.md")
  })

  test("#given an unreadable lesson #when deduplicating #then the read error fails the call", () => {
    // given
    const memory = createMemoryFs({ "/lessons/a.md": "Lesson hash: 0123456789abcdef\n" })
    const deps: StoreDeps = {
      ...memory.deps,
      readFileSync: () => { throw new Error("lesson temporarily unreadable") },
    }

    // when
    const find = () => findLessonByHash("/lessons", "0123456789abcdef", deps)

    // then
    expect(find).toThrow("Failed to read lesson /lessons/a.md: lesson temporarily unreadable")
  })

  test("#given the lesson directory cannot be listed #when deduplicating #then the directory error fails the call", () => {
    // given
    const deps: StoreDeps = {
      existsSync: () => true,
      readdirSync: () => { throw new Error("directory temporarily unreadable") },
    }

    // when
    const find = () => findLessonByHash("/lessons", "0123456789abcdef", deps)

    // then
    expect(find).toThrow("Failed to list lessons in /lessons: directory temporarily unreadable")
  })
})
