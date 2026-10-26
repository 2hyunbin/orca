import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import { agentSessionSendBodyFingerprint } from '../../../../shared/structured-agent-session-send-mutation'
import { getStructuredAgentSessionPendingSends } from './structured-agent-session-pending-sends'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/structured-agent-session-start-failure-row-key'
import {
  structuredAgentSessionCommandItemIds,
  structuredAgentSessionRejectedShownInPlace
} from '../../../../shared/structured-agent-session-message-projection'
import {
  latestAgentSessionContextClearSequence,
  isAgentSessionContextClear
} from '../../../../shared/agent-session-context-clear'
import type { useStructuredAgentSessionSends } from './use-structured-agent-session-sends'

/** Keep the journal payload and context, rather than submitting whatever the composer now holds. */
export function heldTerminalMessageRetry(
  read: () => StructuredAgentSessionState,
  noticeId: string | undefined,
  sessionId: string,
  send: ReturnType<typeof useStructuredAgentSessionSends>['send'],
  isCurrent: () => boolean,
  contextFloor: () => number = () => 0
): (() => void) | null {
  const selected = (state: StructuredAgentSessionState) => {
    const shown = structuredAgentSessionRejectedShownInPlace(
      state.submissions,
      structuredAgentSessionCommandItemIds(state.items),
      state.items.filter((i) => isAgentSessionContextClear(i.body)).map((i) => i.sequence)
    )
    const submission = state.submissions.find(
      (s) =>
        agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity(s.clientMessageId)) ===
          noticeId && shown.has(agentJournalSubmissionKey(s.clientMessageId))
    )
    if (
      submission &&
      getStructuredAgentSessionPendingSends(sessionId).some(
        (entry) =>
          entry.queuedAt >= (submission.resolvedAt ?? Infinity) &&
          agentSessionSendBodyFingerprint(sessionId, entry.body) === submission.payloadFingerprint
      )
    ) {
      return undefined
    }
    return (
      submission &&
      state.items.find((i) => i.itemId === agentJournalSubmissionKey(submission.clientMessageId))
    )
  }
  const before = read(),
    item = selected(before),
    floor = Math.max(contextFloor(), latestAgentSessionContextClearSequence(before.items))
  let consumed = false
  if (!item || item.body.kind !== 'message' || item.sequence <= floor) {
    return null
  }
  const body = item.body
  return () => {
    const current = read()
    if (
      consumed ||
      !isCurrent() ||
      current.epoch !== before.epoch ||
      contextFloor() > floor ||
      latestAgentSessionContextClearSequence(current.items) !==
        latestAgentSessionContextClearSequence(before.items) ||
      selected(current)?.itemId !== item.itemId
    ) {
      return
    }
    consumed = true
    send(
      body.blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(''),
      body.blocks.flatMap((b) =>
        b.type === 'image-ref' ? [{ path: b.path, previewUri: '' }] : []
      ),
      { skills: body.skills }
    )
  }
}
