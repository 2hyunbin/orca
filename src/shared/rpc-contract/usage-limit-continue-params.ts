import { z } from 'zod'

export const CancelUsageLimitContinueParams = z
  .object({
    sessionId: z.string().min(1),
    turnItemId: z.string().min(1).max(4096),
    resetsAt: z.number().finite()
  })
  .strict()
