/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { resolveLessonsDir } from "./paths"

const LESSONS_SUFFIX = ".omo/rules/lessons"

describe("#given an env override, a config directory and project storage", () => {
  test("#when the lessons dir is resolved #then the env override wins", () => {
    // given
    const args = {
      env: { HOME: "/home/tester", OMO_LESSONS_DIR: "/override/lessons" },
      config: { storage: "project", directory: "/configured/lessons" },
      projectDir: "/repo",
    } as const

    // when
    const resolved = resolveLessonsDir(args)

    // then
    expect(resolved).toEqual({ ok: true, path: "/override/lessons" })
  })
})

describe("#given no env override but a config directory and project storage", () => {
  test("#when the lessons dir is resolved #then the untrusted directory is rejected", () => {
    // given
    const args = {
      env: { HOME: "/home/tester" },
      config: { storage: "project", directory: "/configured/lessons" },
      projectDir: "/repo",
    } as const

    // when
    const resolved = resolveLessonsDir(args)

    // then
    expect(resolved).toEqual({ ok: false, error: "Error: lessons.directory is not supported. Use OMO_LESSONS_DIR for an explicit user-controlled override." })
  })
})

describe("#given project storage without an env override or config directory", () => {
  test("#when the lessons dir is resolved #then it is nested under the project dir", () => {
    // given
    const args = { env: { HOME: "/home/tester" }, config: { storage: "project" }, projectDir: "/repo" } as const

    // when
    const resolved = resolveLessonsDir(args)

    // then
    expect(resolved).toEqual({ ok: true, path: join("/repo", LESSONS_SUFFIX) })
  })
})

describe("#given user storage without an env override or config directory", () => {
  test("#when the lessons dir is resolved #then it is nested under the home dir", () => {
    // given
    const args = { env: { HOME: "/home/tester" }, config: { storage: "user" }, projectDir: "/repo" } as const

    // when
    const resolved = resolveLessonsDir(args)

    // then
    expect(resolved).toEqual({ ok: true, path: join("/home/tester", LESSONS_SUFFIX) })
  })
})

describe("#given no lessons config at all", () => {
  test("#when the lessons dir is resolved #then it falls back to the user storage location", () => {
    // given
    const args = { env: { HOME: "/home/tester" }, projectDir: "/repo" } as const

    // when
    const resolved = resolveLessonsDir(args)

    // then
    expect(resolved).toEqual({ ok: true, path: join("/home/tester", LESSONS_SUFFIX) })
  })
})

describe("#given HOME is unset and USERPROFILE is set", () => {
  test("#when the lessons dir is resolved #then USERPROFILE supplies the home dir", () => {
    // given
    const args = { env: { USERPROFILE: "/users/tester" }, projectDir: "/repo" } as const

    // when
    const resolved = resolveLessonsDir(args)

    // then
    expect(resolved).toEqual({ ok: true, path: join("/users/tester", LESSONS_SUFFIX) })
  })
})

describe("#given a whitespace-only env override and a whitespace-only config directory", () => {
  test("#when the lessons dir is resolved #then the configured directory is still rejected", () => {
    // given
    const args = {
      env: { HOME: "/home/tester", OMO_LESSONS_DIR: "   " },
      config: { storage: "project", directory: "  " },
      projectDir: "/repo",
    } as const

    // when
    const resolved = resolveLessonsDir(args)

    // then
    expect(resolved).toEqual({ ok: false, error: "Error: lessons.directory is not supported. Use OMO_LESSONS_DIR for an explicit user-controlled override." })
  })
})
