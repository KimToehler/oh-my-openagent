import { describe, expect, test } from "bun:test"
import { LessonsConfigSchema } from "./lessons"

describe("LessonsConfigSchema", () => {
  test("defaults enabled to false and storage to user", () => {
    const result = LessonsConfigSchema.parse({})

    expect(result.enabled).toBe(false)
    expect(result.storage).toBe("user")
    expect(result.max_files).toBe(200)
    expect(result.max_body_chars).toBe(3000)
  })

  test("parses explicit lessons config", () => {
    const result = LessonsConfigSchema.parse({
      enabled: true,
      storage: "project",
      max_files: 10,
      max_body_chars: 500,
    })

    expect(result.enabled).toBe(true)
    expect(result.storage).toBe("project")
    expect(result.max_files).toBe(10)
    expect(result.max_body_chars).toBe(500)
  })

  test("rejects a configured lessons directory", () => {
    expect(() => LessonsConfigSchema.parse({ directory: "/tmp/lessons" })).toThrow()
  })

  test("rejects out-of-range max files", () => {
    expect(() => LessonsConfigSchema.parse({ max_files: 0 })).toThrow()
    expect(() => LessonsConfigSchema.parse({ max_files: 1001 })).toThrow()
  })

  test("rejects out-of-range max body chars", () => {
    expect(() => LessonsConfigSchema.parse({ max_body_chars: 99 })).toThrow()
    expect(() => LessonsConfigSchema.parse({ max_body_chars: 10001 })).toThrow()
  })

  test("rejects an unknown storage location", () => {
    expect(() => LessonsConfigSchema.parse({ storage: "global" })).toThrow()
  })
})
