// The host's row about a reply cut with nobody asking, and why the Orca running the chat stopped
// when it was Orca: a quit, an update, or a crash (`orcaStop`). A client names the cause, and offers
// Continue. Open on the wire: a cause this build does not know reads as none.

import { parseAgentJournalItemKey } from './agent-session-journal-item-key'
import type {
  AgentJournalPlainStatusItem,
  AgentJournalRenderItem
} from './agent-session-journal-types'
import { CUT_TURN_NOTICE_ROW_PREFIX } from './agent-session-stop-row-identity'

export const AGENT_SESSION_ORCA_STOP_CAUSES = ['update', 'quit', 'crash'] as const
/** The row's presentation, so a client that re-words host rows it can't name passes it through. */
export const AGENT_SESSION_ORCA_STOP_PRESENTATION = 'orca-stop'
export type AgentSessionOrcaStopCause = (typeof AGENT_SESSION_ORCA_STOP_CAUSES)[number]
export type AgentSessionOrcaStop = { cause: AgentSessionOrcaStopCause }

export function isAgentSessionOrcaStopCause(value: unknown): value is AgentSessionOrcaStopCause {
  return AGENT_SESSION_ORCA_STOP_CAUSES.some((cause) => cause === value)
}

/** The stop a row states, when this build knows its cause. */
export function readAgentSessionOrcaStop(value: unknown): AgentSessionOrcaStop | undefined {
  const cause =
    typeof value === 'object' && value !== null && 'cause' in value ? value.cause : undefined
  return isAgentSessionOrcaStopCause(cause) ? { cause } : undefined
}

/** The row's own words, which a client that names no cause prints as they are. */
export const AGENT_SESSION_ORCA_STOP_TEXT =
  'This response was interrupted. You can continue in this conversation.'

/** The row about a reply cut with nobody asking: muted, since nothing failed, and naming why Orca
 *  stopped when it was Orca. */
export function agentSessionOrcaStopRowBody(orcaEnd: unknown): AgentJournalPlainStatusItem {
  return {
    kind: 'status',
    text: AGENT_SESSION_ORCA_STOP_TEXT,
    tone: 'notice',
    presentation: AGENT_SESSION_ORCA_STOP_PRESENTATION,
    ...(isAgentSessionOrcaStopCause(orcaEnd) ? { orcaStop: { cause: orcaEnd } } : {})
  }
}

/** The stop a host's row states, with its cause when this build knows one; null for any other row.
 *  A client's derived notice is none: no host can continue from a row it never wrote. */
export function readAgentSessionOrcaStopRow(
  item: Pick<AgentJournalRenderItem, 'itemId' | 'body'>
): Partial<AgentSessionOrcaStop> | null {
  if (item.body.kind !== 'status') {
    return null
  }
  const stop = readAgentSessionOrcaStop(item.body.orcaStop)
  if (stop || item.body.presentation !== AGENT_SESSION_ORCA_STOP_PRESENTATION) {
    return stop ?? null
  }
  const identity = parseAgentJournalItemKey(item.itemId)
  return identity?.provider === 'orca' &&
    identity.clientMessageId.startsWith(CUT_TURN_NOTICE_ROW_PREFIX)
    ? null
    : {}
}
