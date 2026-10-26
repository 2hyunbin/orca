import { z } from 'zod'
import { SessionId } from './structured-agent-session-identifiers'

// Not strict: an older host ignores these params entirely, and this host must ignore a newer client's.
export const SubscribeTurnCompletionsParams = z
  .object({
    includePrompts: z.boolean().optional(),
    phoneRelaySessionId: SessionId.optional()
  })
  .refine((params) => !params.phoneRelaySessionId || params.includePrompts === true, {
    message: 'Phone forwarding requires prompt delivery'
  })
