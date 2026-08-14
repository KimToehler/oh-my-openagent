import { z } from "zod"

export const LessonsConfigSchema = z.strictObject({
  /** Enable the lessons subsystem (default: false) */
  enabled: z.boolean().default(false),
  /** Where lessons are stored: "user" writes to ~/.omo/rules/lessons, "project" writes to .omo/rules/lessons */
  storage: z.enum(["user", "project"]).default("user"),
  /** Maximum number of lesson files kept in the lessons directory (default: 200) */
  max_files: z.number().min(1).max(1000).default(200),
  /** Maximum character length of a single lesson body (default: 3000) */
  max_body_chars: z.number().min(100).max(10000).default(3000),
  /** Show a nudge on next user message in running TUI or serve sessions, not oh-my-opencode run, which exits between turns (default: true) */
  nudge: z.boolean().default(true),
})

export type LessonsConfig = z.infer<typeof LessonsConfigSchema>
