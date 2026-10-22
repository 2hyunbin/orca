import type { ConnectorSource } from '../../shared/external-conversation-link'
import type { WriteSettlement } from '../../shared/pty-write-settlement'

export type ConversationKey = { source: ConnectorSource; externalId: string }

/** Why the seam declined before any byte left it. */
export type ConnectorRefusal =
  | 'connectors_disabled'
  | 'write_refused'
  | 'busy'
  | 'agent_not_reachable'
  | 'unsupported_agent'
  | 'delivery_id_reused'

/**
 * The connector's own answer, weaker than a `WriteSettlement`: `accepted` means the writer
 * returned, never that the agent read it. `write` is nested only where a raw write settled.
 */
export type Delivery =
  | { outcome: 'accepted' }
  | { outcome: 'refused'; reason: ConnectorRefusal; write?: WriteSettlement }
  | {
      outcome: 'unknown'
      reason: 'launch_outcome_unknown' | 'writer_failed' | 'write_unverifiable'
      write?: WriteSettlement
    }

export type ConversationStart = { conversation: ConversationKey; initial: Delivery }

export function refused(reason: ConnectorRefusal): Delivery {
  return { outcome: 'refused', reason }
}

/** One string per conversation, unambiguous for any id text. */
export function conversationId(key: ConversationKey): string {
  return JSON.stringify([key.source, key.externalId])
}
