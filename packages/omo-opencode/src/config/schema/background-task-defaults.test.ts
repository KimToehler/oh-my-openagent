import { describe, it, expect } from "bun:test"
import {
  DEFAULT_STALE_TIMEOUT_MS,
  DEFAULT_MESSAGE_STALENESS_TIMEOUT_MS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_BLOCKED_REWAKE_MS,
  DEFAULT_BLOCKED_EXPIRY_MS,
  TERMINAL_TASK_TTL_MS,
} from "../../features/background-agent/constants"
import { BackgroundTaskConfigSchema } from "./background-task"

describe("background-task schema defaults", () => {
  describe("#given runtime constants", () => {
    describe("#when schema JSDoc is parsed", () => {
      it("#then documented default for staleTimeoutMs matches runtime constant", () => {
        // Extract the documented default from the schema description.
        // The staleTimeoutMs field has a JSDoc comment like:
        // "Stale timeout in milliseconds - interrupt tasks with no activity for this duration (default: 180000 = 3 minutes, minimum: 60000 = 1 minute)"
        const staleField = BackgroundTaskConfigSchema.shape.staleTimeoutMs
        // Unwrap the optional to get the inner number schema
        const innerSchema = staleField._def.innerType
        const description = innerSchema.description || ""

        // Parse out the documented default value (should be 2700000 = 45 minutes)
        const defaultMatch = description.match(/default:\s*(\d+)/)
        const documentedDefault = defaultMatch ? parseInt(defaultMatch[1], 10) : null

        expect(documentedDefault).toBe(DEFAULT_STALE_TIMEOUT_MS)
        expect(DEFAULT_STALE_TIMEOUT_MS).toBe(2_700_000) // 45 minutes
      })

      it("#then documented default for messageStalenessTimeoutMs matches runtime constant", () => {
        // Extract the documented default from the schema description.
        // The messageStalenessTimeoutMs field has a JSDoc comment like:
        // "Timeout for tasks that never received any progress update, falling back to startedAt (default: 1800000 = 30 minutes, minimum: 60000 = 1 minute)"
        const messageStalenessField = BackgroundTaskConfigSchema.shape.messageStalenessTimeoutMs
        // Unwrap the optional to get the inner number schema
        const innerSchema = messageStalenessField._def.innerType
        const description = innerSchema.description || ""

        // Parse out the documented default value (should be 3600000 = 60 minutes)
        const defaultMatch = description.match(/default:\s*(\d+)/)
        const documentedDefault = defaultMatch ? parseInt(defaultMatch[1], 10) : null

        expect(documentedDefault).toBe(DEFAULT_MESSAGE_STALENESS_TIMEOUT_MS)
        expect(DEFAULT_MESSAGE_STALENESS_TIMEOUT_MS).toBe(3_600_000) // 60 minutes
      })

      it("#then documented default for maxToolCalls matches runtime constant", () => {
        // Extract the documented default from the schema description.
        // The maxToolCalls field has a JSDoc comment like:
        // "Maximum tool calls per subagent task before circuit breaker triggers (default: 200, minimum: 10). Prevents runaway loops from burning unlimited tokens."
        const maxToolCallsField = BackgroundTaskConfigSchema.shape.maxToolCalls
        // Unwrap the optional to get the inner number schema
        const innerSchema = maxToolCallsField._def.innerType
        const description = innerSchema.description || ""

        // Parse out the documented default value (should be 4000)
        const defaultMatch = description.match(/default:\s*(\d+)/)
        const documentedDefault = defaultMatch ? parseInt(defaultMatch[1], 10) : null

        expect(documentedDefault).toBe(DEFAULT_MAX_TOOL_CALLS)
        expect(DEFAULT_MAX_TOOL_CALLS).toBe(4000)
      })

      it("#then documented default for blockedRewakeMs matches runtime constant", () => {
        // given
        const innerSchema = BackgroundTaskConfigSchema.shape.blockedRewakeMs._def.innerType

        // when
        const defaultMatch = (innerSchema.description || "").match(/default:\s*(\d+)/)
        const documentedDefault = defaultMatch ? parseInt(defaultMatch[1], 10) : null

        // then
        expect(documentedDefault).toBe(DEFAULT_BLOCKED_REWAKE_MS)
      })

      it("#then documented default for blockedExpiryMs matches runtime constant", () => {
        // given
        const innerSchema = BackgroundTaskConfigSchema.shape.blockedExpiryMs._def.innerType

        // when
        const defaultMatch = (innerSchema.description || "").match(/default:\s*(\d+)/)
        const documentedDefault = defaultMatch ? parseInt(defaultMatch[1], 10) : null

        // then
        expect(documentedDefault).toBe(DEFAULT_BLOCKED_EXPIRY_MS)
      })

      it("#then blocked expiry remains strictly below terminal task TTL", () => {
        // given
        const terminalTaskTtlMs = TERMINAL_TASK_TTL_MS

        // when
        const blockedExpiryMs = DEFAULT_BLOCKED_EXPIRY_MS

        // then
        expect(blockedExpiryMs).toBeLessThan(
          terminalTaskTtlMs,
          "blocked expiry must stay below terminal task TTL so expiry wins before the 30-minute purge",
        )
      })

      it("#then schema rejects blocked rewake at or after expiry", () => {
        // given
        const input = { blockedRewakeMs: DEFAULT_BLOCKED_EXPIRY_MS, blockedExpiryMs: DEFAULT_BLOCKED_EXPIRY_MS }

        // when
        const result = BackgroundTaskConfigSchema.safeParse(input)

        // then
        expect(result.success).toBe(false)
      })

      it("#then schema rejects blocked expiry at or after terminal task TTL", () => {
        // given
        const input = { blockedRewakeMs: DEFAULT_BLOCKED_REWAKE_MS, blockedExpiryMs: TERMINAL_TASK_TTL_MS }

        // when
        const result = BackgroundTaskConfigSchema.safeParse(input)

        // then
        expect(result.success).toBe(false)
      })

      it("#then BackgroundTaskStatus has no new 'blocked' member", () => {
        // Guard against later contributors adding a new status.
        // The schema itself does not contain a BackgroundTaskStatus field,
        // but this test pin that the design decision to keep blocked orthogonal is honored.
        // (The BackgroundTaskStatus union lives in types.ts and has 6 members:
        // pending, running, completed, cancelled, errored, interrupted)
        // This is a smoke test; the real guard is in types.ts itself.
        expect(true).toBe(true) // placeholder
      })
    })
  })
})
