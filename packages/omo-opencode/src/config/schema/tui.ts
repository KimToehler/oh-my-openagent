import { z } from "zod"

export const TuiSidebarConfigSchema = z.object({
  enabled: z.boolean().default(true),
  workflow_cheatsheet: z.boolean().default(false),
})

export const TuiConfigSchema = z.object({
  sidebar: TuiSidebarConfigSchema.default({ enabled: true, workflow_cheatsheet: false }),
})

export type TuiConfig = z.infer<typeof TuiConfigSchema>
