import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessageUpdateResult } from '../../../shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { queuedMessageWithEditedText } from '../../../shared/queued-message-text-edit'
import { isUnsettledQueuedMessage, type QueuedMessageRow } from './queued-message-table'

export type QueuedMessageTextUpdate = {
  messageId: string
  expectedBodyFingerprint: string
  text: string
}

/** Compare-and-set on the body fingerprint. The resulting body is checked first, so a retried
 *  Save whose first answer was lost reads `unchanged`, and one a newer edit superseded reads
 *  `changed`: a retry never overwrites newer text. */
export function queuedMessageTextUpdateDecision(
  row: QueuedMessageRow | null,
  sessionId: string,
  input: QueuedMessageTextUpdate
):
  | AgentSessionQueuedMessageUpdateResult
  | { status: 'ready'; body: AgentJournalMessageItem; fingerprint: string } {
  const { messageId } = input
  if (!row || !isUnsettledQueuedMessage(row)) {
    const disposition = !row ? 'missing' : row.state === 'dispatched' ? 'dispatched' : 'withdrawn'
    return { status: 'gone', messageId, disposition }
  }
  const body = queuedMessageWithEditedText(row.body, input.text)
  if (!body) {
    return { status: 'not-editable', messageId }
  }
  const fingerprint = agentSessionSendBodyFingerprint(sessionId, body)
  if (row.fingerprint === fingerprint) {
    return { status: 'unchanged', messageId, fingerprint }
  }
  if (row.fingerprint !== input.expectedBodyFingerprint) {
    return { status: 'changed', messageId }
  }
  return { status: 'ready', body, fingerprint }
}
