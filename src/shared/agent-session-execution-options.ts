import { z } from 'zod'

/** Choices fixed when a message is accepted. Permission remains a launch setting. */
export const AgentSessionExecutionOptionsSchema = z
  .object({
    model: z.string().min(1).max(256).optional(),
    effort: z.string().min(1).max(64).optional(),
    personality: z.string().min(1).max(64).optional(),
    fastMode: z.enum(['true', 'false']).optional(),
    serviceTier: z.string().min(1).max(64).optional()
  })
  .strict()

export type AgentSessionExecutionOptions = z.infer<typeof AgentSessionExecutionOptionsSchema>

export function readAgentSessionExecutionOptions(
  value: unknown
): AgentSessionExecutionOptions | null {
  const parsed = AgentSessionExecutionOptionsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
