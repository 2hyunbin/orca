import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { journalItemDeclaresEcho } from './journal-item-echo'
import type { JournalReducerState } from './journal-reducer'

export function resolveJournalItemId(
  state: JournalReducerState,
  itemId: string,
  body?: AgentJournalRenderItem['body']
): string {
  const aliased = state.aliases.get(itemId)
  if (aliased) {
    return aliased
  }
  const submissionId = journalEchoClaimant(state, itemId, body)
  if (!submissionId) {
    return itemId
  }
  state.aliases.set(itemId, submissionId)
  return submissionId
}

export function isProviderUserMessageEcho(
  itemId: string,
  body: AgentJournalRenderItem['body']
): boolean {
  const identity = parseAgentJournalItemKey(itemId)
  return (
    body.kind === 'message' &&
    body.role === 'user' &&
    identity !== null &&
    identity.provider !== 'orca'
  )
}

/** Find an echo's eligible submission without claiming it. */
export function journalEchoClaimant(
  state: JournalReducerState,
  itemId: string,
  body?: AgentJournalRenderItem['body']
): string | null {
  if (
    !body ||
    journalItemDeclaresEcho(state.itemEchoes, itemId) ||
    !isProviderUserMessageEcho(itemId, body)
  ) {
    return null
  }
  const fingerprint = agentSessionSendBodyFingerprint(state.sessionId, body)
  const raw = state.selection.echo(fingerprint)
  return raw === undefined ? null : agentJournalSubmissionKey(raw)
}
