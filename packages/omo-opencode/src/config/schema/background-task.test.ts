import { describe, expect, test } from "bun:test"
import { ZodError } from "zod"
import { BackgroundTaskConfigSchema } from "./background-task"
import { OhMyOpenCodeConfigSchema } from "./oh-my-opencode-config"

describe("BackgroundTaskConfigSchema", () => {
  describe("maxDepth", () => {
    describe("#given valid maxDepth (3)", () => {
      test("#when parsed #then returns correct value", () => {
        const result = BackgroundTaskConfigSchema.parse({ maxDepth: 3 })

        expect(result.maxDepth).toBe(3)
      })
    })

    describe("#given maxDepth below minimum (0)", () => {
      test("#when parsed #then throws ZodError", () => {
        let thrownError: unknown

        try {
          BackgroundTaskConfigSchema.parse({ maxDepth: 0 })
        } catch (error) {
          thrownError = error
        }

        expect(thrownError).toBeInstanceOf(ZodError)
      })
    })
  })

  describe("syncPollTimeoutMs", () => {
    describe("#given valid syncPollTimeoutMs (120000)", () => {
      test("#when parsed #then returns correct value", () => {
        const result = BackgroundTaskConfigSchema.parse({ syncPollTimeoutMs: 120000 })

        expect(result.syncPollTimeoutMs).toBe(120000)
      })
    })

    describe("#given syncPollTimeoutMs below minimum (59999)", () => {
      test("#when parsed #then throws ZodError", () => {
        let thrownError: unknown

        try {
          BackgroundTaskConfigSchema.parse({ syncPollTimeoutMs: 59999 })
        } catch (error) {
          thrownError = error
        }

        expect(thrownError).toBeInstanceOf(ZodError)
      })
    })

    describe("#given syncPollTimeoutMs not provided", () => {
      test("#when parsed #then field is undefined", () => {
        const result = BackgroundTaskConfigSchema.parse({})

        expect(result.syncPollTimeoutMs).toBeUndefined()
      })
    })

    describe('#given syncPollTimeoutMs is non-number ("abc")', () => {
      test("#when parsed #then throws ZodError", () => {
        let thrownError: unknown

        try {
          BackgroundTaskConfigSchema.parse({ syncPollTimeoutMs: "abc" })
        } catch (error) {
          thrownError = error
        }

        expect(thrownError).toBeInstanceOf(ZodError)
      })
    })
  })

  describe("todoGateGraceMs", () => {
    describe("#given valid todoGateGraceMs (600000)", () => {
      test("#when parsed #then returns correct value", () => {
        const result = BackgroundTaskConfigSchema.parse({ todoGateGraceMs: 600000 })

        expect(result.todoGateGraceMs).toBe(600000)
      })
    })

    describe("#given todoGateGraceMs below minimum (59999)", () => {
      test("#when parsed #then reports minimum failure", () => {
        const result = BackgroundTaskConfigSchema.safeParse({ todoGateGraceMs: 59999 })

        expect(result.success).toBe(false)
        if (!result.success) {
          expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["todoGateGraceMs"] }))
        }
      })
    })

    describe("#given todoGateGraceMs not provided", () => {
      test("#when parsed #then field is undefined", () => {
        const result = BackgroundTaskConfigSchema.parse({})

        expect(result.todoGateGraceMs).toBeUndefined()
      })
    })

    describe("#given todoGateGraceMs at or after configured taskTtlMs", () => {
      test("#when safeParsed #then reports ttl ordering failure", () => {
        const result = BackgroundTaskConfigSchema.safeParse({ todoGateGraceMs: 600000, taskTtlMs: 300000 })

        expect(result.success).toBe(false)
        if (!result.success) {
          expect(result.error.issues).toContainEqual(expect.objectContaining({
            path: ["todoGateGraceMs"],
            message: "todoGateGraceMs must be less than taskTtlMs",
          }))
        }
      })
    })

    describe("#given todoGateGraceMs at default task TTL with taskTtlMs unset", () => {
      test("#when safeParsed #then reports default ttl ordering failure", () => {
        const result = BackgroundTaskConfigSchema.safeParse({ todoGateGraceMs: 1800000 })

        expect(result.success).toBe(false)
        if (!result.success) {
          expect(result.error.issues).toContainEqual(expect.objectContaining({
            path: ["todoGateGraceMs"],
            message: "todoGateGraceMs must be less than taskTtlMs",
          }))
        }
      })
    })
  })

  describe("syncWallClockTimeoutMs", () => {
    describe("#given valid syncWallClockTimeoutMs (600000)", () => {
      test("#when parsed #then returns correct value", () => {
        const result = BackgroundTaskConfigSchema.parse({ syncWallClockTimeoutMs: 600000 })

        expect(result.syncWallClockTimeoutMs).toBe(600000)
      })
    })

    describe("#given syncWallClockTimeoutMs below minimum (59999)", () => {
      test("#when parsed #then throws ZodError", () => {
        let thrownError: unknown

        try {
          BackgroundTaskConfigSchema.parse({ syncWallClockTimeoutMs: 59999 })
        } catch (error) {
          thrownError = error
        }

        expect(thrownError).toBeInstanceOf(ZodError)
      })
    })

    describe("#given syncWallClockTimeoutMs not provided", () => {
      test("#when parsed #then field is undefined", () => {
        const result = BackgroundTaskConfigSchema.parse({})

        expect(result.syncWallClockTimeoutMs).toBeUndefined()
      })
    })

    describe('#given syncWallClockTimeoutMs is non-number ("600000")', () => {
      test("#when parsed #then throws ZodError", () => {
        let thrownError: unknown

        try {
          BackgroundTaskConfigSchema.parse({ syncWallClockTimeoutMs: "600000" })
        } catch (error) {
          thrownError = error
        }

        expect(thrownError).toBeInstanceOf(ZodError)
      })
    })

    describe("#given syncWallClockTimeoutMs is negative (-1)", () => {
      test("#when parsed #then throws ZodError", () => {
        let thrownError: unknown

        try {
          BackgroundTaskConfigSchema.parse({ syncWallClockTimeoutMs: -1 })
        } catch (error) {
          thrownError = error
        }

        expect(thrownError).toBeInstanceOf(ZodError)
      })
    })

    describe("#given root config carrying background_task.syncWallClockTimeoutMs (600000)", () => {
      test("#when safeParsed #then succeeds and preserves the value", () => {
        const result = OhMyOpenCodeConfigSchema.safeParse({
          background_task: { syncWallClockTimeoutMs: 600000 },
        })

        expect(result.success).toBe(true)
        if (result.success) {
          expect(result.data.background_task?.syncWallClockTimeoutMs).toBe(600000)
        }
      })
    })
  })
})
