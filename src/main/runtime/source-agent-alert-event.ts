import { z } from 'zod'

const identity = z.object({
  notificationId: z.string().min(1).max(2048),
  notificationEpoch: z.string().min(1).max(128),
  notificationSeq: z.number().int().nonnegative()
})

/** The source stream carries semantic news and opaque destinations, never push credentials. */
export const SourceAgentAlertEvent = z.discriminatedUnion('type', [
  identity.extend({
    type: z.literal('notification'),
    source: z.literal('agent-task-complete'),
    title: z.string(),
    body: z.string(),
    worktreeId: z.string(),
    agentState: z.enum(['working', 'done', 'waiting', 'blocked']).optional(),
    desktopAllowed: z.boolean().optional(),
    emittedAt: z.number().optional(),
    attentionKey: z.string().optional(),
    sourcePlan: z.object({
      kind: z.enum(['terminal', 'structured']),
      direct: z.array(z.string().regex(/^[a-f0-9]{64}$/))
    })
  }),
  z.object({ type: z.literal('dismiss'), notificationId: z.string(), dismissedDelivery: identity })
])
export type SourceAgentAlertEvent = z.infer<typeof SourceAgentAlertEvent>
