import { z } from 'zod'
import {
  boundJournalKeyComponent,
  parseAgentJournalItemKey
} from './agent-session-journal-item-key'

const Key = z
  .string()
  .min(1)
  .max(16384)
  .refine((value) => parseAgentJournalItemKey(value) !== null)
export const AgentSessionSemanticWorkSchema = z.object({
  kind: z.literal('semantic-work'),
  version: z.literal(1),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('submission'), clientMessageId: z.string().min(1) }),
    z.object({
      kind: z.literal('child'),
      invocationId: z.string().uuid(),
      idKind: z.enum(['task_id', 'thread_id']),
      handleId: z.string().min(1),
      runId: z.string().min(1).optional(),
      ownerId: z.string().min(1).optional()
    })
  ]),
  startedAt: z.number().finite(),
  phase: z.enum(['open', 'settled', 'interrupted']),
  afterRequest: Key.nullable().optional()
})
export type AgentSessionSemanticWork = z.infer<typeof AgentSessionSemanticWorkSchema>

export function semanticWorkRecordId(source: AgentSessionSemanticWork['source']): string {
  return JSON.stringify([
    'semantic-work',
    1,
    source.kind,
    source.kind === 'child' ? source.invocationId : source.clientMessageId
  ])
}

export function semanticWorkKeyAgrees(itemId: unknown, body: unknown): boolean {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('kind' in body) ||
    body.kind !== 'semantic-work'
  ) {
    return true
  }
  const parsed = AgentSessionSemanticWorkSchema.safeParse(body)
  const identity = typeof itemId === 'string' ? parseAgentJournalItemKey(itemId) : null
  return (
    parsed.success &&
    identity?.provider === 'legacy' &&
    identity.recordId === boundJournalKeyComponent(semanticWorkRecordId(parsed.data.source)) &&
    (parsed.data.phase !== 'interrupted' || parsed.data.afterRequest !== undefined)
  )
}
