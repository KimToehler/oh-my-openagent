import { z } from "zod"
import { TASK_TTL_MS, TERMINAL_TASK_TTL_MS } from "../../features/background-agent/constants"

const CircuitBreakerConfigSchema = z.object({
  enabled: z.boolean().optional(),
  maxToolCalls: z.number().int().min(10).optional(),
  consecutiveThreshold: z.number().int().min(5).optional(),
})

export const BackgroundTaskConfigSchema = z.object({
  defaultConcurrency: z.number().min(1).optional(),
  /** Max time a task waits for a concurrency slot before failing, in milliseconds (default: 600000 = 10 minutes; 0 disables the timeout). Guards against a slot that was never released stranding every later task on the same key. */
  acquireTimeoutMs: z.number().min(0).optional(),
  providerConcurrency: z.record(z.string(), z.number().min(0)).optional(),
  modelConcurrency: z.record(z.string(), z.number().min(0)).optional(),
  maxDepth: z.number().int().min(1).optional(),
  /** Stale timeout in milliseconds - interrupt tasks with no activity for this duration (default: 2700000 = 45 minutes, minimum: 60000 = 1 minute) */
  staleTimeoutMs: z.number().describe("Stale timeout in milliseconds - interrupt tasks with no activity for this duration (default: 2700000 = 45 minutes, minimum: 60000 = 1 minute)").min(60000).optional(),
  /** Timeout for tasks that never received any progress update, falling back to startedAt (default: 3600000 = 60 minutes, minimum: 60000 = 1 minute) */
  messageStalenessTimeoutMs: z.number().describe("Timeout for tasks that never received any progress update, falling back to startedAt (default: 3600000 = 60 minutes, minimum: 60000 = 1 minute)").min(60000).optional(),
  /** Absolute TTL for non-terminal tasks in milliseconds (default: 1800000 = 30 minutes, minimum: 300000 = 5 minutes). Tasks exceeding this age from their last activity (or startedAt if no progress) are pruned. */
  taskTtlMs: z.number().min(300000).optional(),
  /** Timeout for tasks whose session has completely disappeared from the status registry (default: 60000 = 1 minute, minimum: 10000 = 10 seconds). When a session is gone (likely crashed), this shorter timeout is used instead of the normal stale timeout. */
  sessionGoneTimeoutMs: z.number().min(10000).optional(),
  /** Delay before removing completed/cancelled/errored tasks from memory in milliseconds (default: 600000 = 10 minutes, minimum: 60000 = 1 minute). */
  taskCleanupDelayMs: z.number().min(60000).optional(),
  /** Delay before sending one reminder for an unanswered blocked task in milliseconds (default: 600000 = 10 minutes, minimum: 60000 = 1 minute). */
  blockedRewakeMs: z.number().describe("Delay before sending one reminder for an unanswered blocked task in milliseconds (default: 600000 = 10 minutes, minimum: 60000 = 1 minute).").min(60000).optional(),
  /** Time before an unanswered blocked task expires in milliseconds (default: 1200000 = 20 minutes, minimum: 60000 = 1 minute). Must remain below the terminal task TTL. */
  blockedExpiryMs: z.number().describe("Time before an unanswered blocked task expires in milliseconds (default: 1200000 = 20 minutes, minimum: 60000 = 1 minute). Must remain below the terminal task TTL.").min(60000).optional(),
  /** Grace period in milliseconds a background task may stay continuously idle with valid output but incomplete todos before completing anyway (default: 600000 = 10 minutes, minimum: 60000 = 1 minute). Must remain below taskTtlMs. */
  todoGateGraceMs: z.number().describe("Grace period in milliseconds a background task may stay continuously idle with valid output but incomplete todos before completing anyway (default: 600000 = 10 minutes, minimum: 60000 = 1 minute). Must remain below taskTtlMs.").min(60000).optional(),
  syncPollTimeoutMs: z.number().min(60000).optional(),
  syncWallClockTimeoutMs: z
    .number()
    .min(60000)
    .optional()
    .describe(
      "Absolute wall-clock ceiling on synchronous task delegation in milliseconds (default: 600000 = 10 minutes, minimum: 60000 = 1 minute). When exceeded, the still-running child session is handed to the background manager rather than aborted, so none of its work is lost and the parent receives a background task handle instead of a result. Independent of and additional to the inactivity window governed by syncPollTimeoutMs, which any child activity resets.",
    ),
  /** Maximum tool calls per subagent task before circuit breaker triggers (default: 4000, minimum: 10). Prevents runaway loops from burning unlimited tokens. */
  maxToolCalls: z.number().int().describe("Maximum tool calls per subagent task before circuit breaker triggers (default: 4000, minimum: 10). Prevents runaway loops from burning unlimited tokens.").min(10).optional(),
  circuitBreaker: CircuitBreakerConfigSchema.optional(),
}).superRefine((config, context) => {
  if (config.blockedRewakeMs !== undefined && config.blockedExpiryMs !== undefined && config.blockedRewakeMs >= config.blockedExpiryMs) {
    context.addIssue({
      code: "custom",
      path: ["blockedRewakeMs"],
      message: "blockedRewakeMs must be less than blockedExpiryMs",
    })
  }

  if (config.blockedExpiryMs !== undefined && config.blockedExpiryMs >= TERMINAL_TASK_TTL_MS) {
    context.addIssue({
      code: "custom",
      path: ["blockedExpiryMs"],
      message: "blockedExpiryMs must be less than the terminal task TTL",
    })
  }

  if (config.todoGateGraceMs !== undefined && config.todoGateGraceMs >= (config.taskTtlMs ?? TASK_TTL_MS)) {
    context.addIssue({
      code: "custom",
      path: ["todoGateGraceMs"],
      message: "todoGateGraceMs must be less than taskTtlMs",
    })
  }
})

export type BackgroundTaskConfig = z.infer<typeof BackgroundTaskConfigSchema>
