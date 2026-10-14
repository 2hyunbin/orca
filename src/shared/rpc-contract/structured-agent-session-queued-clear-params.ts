import { z } from 'zod'
import { AGENT_SESSION_MAX_QUEUED_CLEAR_IDS } from '../agent-session-queued-message-wire'
import { Identifier, MutationEnvelope } from './structured-agent-session-params'

/** The client's bounded snapshot, never a request to delete cards admitted later. */
export const QueuedMessagesClearParams = z
  .object({
    envelope: MutationEnvelope,
    messageIds: z
      .array(Identifier('Invalid queued message id'))
      .min(1)
      .max(AGENT_SESSION_MAX_QUEUED_CLEAR_IDS)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate queued message id')
  })
  .strict()
