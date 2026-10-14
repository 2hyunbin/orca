import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageUpdateResult
} from '../../../src/shared/agent-session-wire'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../../src/shared/structured-agent-session-send-mutation'
import { queuedMessageWithEditedText } from '../../../src/shared/queued-message-text-edit'
import type { StructuredAgentSessionMutationResult } from './mobile-structured-agent-session-rpc'
import type { MobileQueuedMessageCard } from './mobile-structured-queued-message-cards'
import type { MobileQueuedEditLease } from './mobile-queued-message-edit-lease'

export type MobileQueuedEditSave = {
  scope: string
  sessionId: string
  messageId: string
  body: AgentSessionQueuedMessage['body']
  originalText: string
  text: string
  fingerprint: string
  publication: readonly AgentSessionQueuedMessage[] | null
  saving: boolean
  lease: MobileQueuedEditLease
  keepText: ((text: string) => boolean) | undefined
}

const detachedSaves = new Map<string, MobileQueuedEditSave>()

export function detachQueuedEditSave(edit: MobileQueuedEditSave): void {
  detachedSaves.set(edit.scope, edit)
}

export function detachedQueuedEditSave(scope: string): MobileQueuedEditSave | undefined {
  return detachedSaves.get(scope)
}

export function forgetDetachedQueuedEditSave(scope: string): void {
  detachedSaves.delete(scope)
}

/** Null means this edit is not detached; unknown remains owned until publication. */
export function settleDetachedQueuedEditSave(
  edit: MobileQueuedEditSave,
  result: StructuredAgentSessionMutationResult<AgentSessionQueuedMessageUpdateResult>
): 'saved' | 'failed' | 'unknown' | null {
  if (detachedSaves.get(edit.scope) !== edit) {
    return null
  }
  if (result.status === 'unknown') {
    return 'unknown'
  }
  detachedSaves.delete(edit.scope)
  if (
    result.status === 'accepted' &&
    (result.value.status === 'updated' || result.value.status === 'unchanged')
  ) {
    return 'saved'
  }
  if (edit.text !== edit.originalText) {
    edit.keepText?.(edit.text)
  }
  return 'failed'
}

export function detachedQueuedEditPublication(args: {
  edit: MobileQueuedEditSave
  messages: readonly AgentSessionQueuedMessage[] | null
  cards: readonly MobileQueuedMessageCard[]
  submissions: readonly AgentJournalSubmission[]
}): 'wait' | 'saved' | 'restore' | 'resume' {
  const { edit, messages, cards, submissions } = args
  if (messages === null) {
    return 'wait'
  }
  const desiredBody = queuedMessageWithEditedText(edit.body, edit.text)
  const desired = desiredBody ? agentSessionSendBodyFingerprint(edit.sessionId, desiredBody) : null
  const listed = messages.find((message) => message.messageId === edit.messageId)
  if (
    submissions.some(
      (entry) => entry.queuedMessageId === edit.messageId && entry.payloadFingerprint === desired
    ) ||
    (listed && agentSessionSendBodyFingerprint(edit.sessionId, listed.body) === desired)
  ) {
    return 'saved'
  }
  if (messages === edit.publication) {
    return 'wait'
  }
  if (
    !listed ||
    !cards.some((card) => card.messageId === edit.messageId) ||
    agentSessionSendBodyFingerprint(edit.sessionId, listed.body) !== edit.fingerprint
  ) {
    return 'restore'
  }
  return 'resume'
}
