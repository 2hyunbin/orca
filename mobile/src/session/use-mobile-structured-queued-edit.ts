import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageUpdateResult
} from '../../../src/shared/agent-session-wire'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../../src/shared/structured-agent-session-send-mutation'
import {
  queuedMessageEditableText,
  queuedMessageWithEditedText
} from '../../../src/shared/queued-message-text-edit'
import type { RpcClient } from '../transport/rpc-client'
import {
  startMobileQueuedEditLease,
  type MobileQueuedEditLease
} from './mobile-queued-message-edit-lease'
import type { MobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'
import type { MobileQueuedMessageCard } from './mobile-structured-queued-message-cards'

export type MobileQueuedMessageInlineEditor = {
  messageId: string
  text: string
  acquiring: boolean
  saving: boolean
  canSave: boolean
  change: (text: string) => void
  save: () => Promise<boolean>
  cancel: () => void
}

type Edit = {
  scope: string
  messageId: string
  body: AgentSessionQueuedMessage['body']
  originalText: string
  text: string
  fingerprint: string
  acquiring: boolean
  saving: boolean
  lease: MobileQueuedEditLease
  keepText: ((text: string) => boolean) | undefined
}

export function useMobileStructuredQueuedEdit(args: {
  sessionKey: string
  sessionId: string | null
  client: RpcClient | null
  enabled: boolean
  promptOpen: boolean
  messages: readonly AgentSessionQueuedMessage[] | null
  cards: readonly MobileQueuedMessageCard[]
  submissions: readonly AgentJournalSubmission[]
  mutate: MobileStructuredAgentMutate
  captureComposerTextAppender: () => ((text: string) => boolean) | undefined
  onSendError: (text: string) => void
  onActionResolved?: () => void
}) {
  const { sessionKey, sessionId, client, enabled, mutate, onSendError, onActionResolved } = args
  const active = useRef<Edit | null>(null)
  const [shown, setShown] = useState<Edit | null>(null)
  const latest = useRef(args)
  useEffect(() => {
    latest.current = args
  }, [args])
  const render = useCallback((edit: Edit | null) => {
    active.current = edit
    setShown(edit ? { ...edit } : null)
  }, [])
  const close = useCallback(() => {
    const edit = active.current
    render(null)
    edit?.lease.end()
  }, [render])
  const recover = useCallback(
    (edit: Edit, reason: 'changed' | 'gone') => {
      if (edit.text !== edit.originalText && edit.keepText?.(edit.text)) {
        const message =
          reason === 'changed'
            ? 'This message changed while you were editing.'
            : 'This message was already sent or removed.'
        const placement = latest.current.promptOpen
          ? 'Your edit will be in the chat box after you answer the agent.'
          : 'Your edit is in the chat box.'
        onSendError(`${message} ${placement}`)
      }
      close()
    },
    [close, onSendError]
  )
  // Capture the originating composer's callback before a tab switch changes its target.
  useEffect(() => {
    return () => {
      const edit = active.current
      active.current = null
      setShown(null)
      if (edit && edit.text !== edit.originalText) {
        edit.keepText?.(edit.text)
      }
      edit?.lease.end()
    }
  }, [sessionKey, client, enabled])

  const begin = useCallback(
    async (messageId: string): Promise<boolean> => {
      if (active.current || !enabled || !client || !sessionId) {
        return false
      }
      const message = latest.current.messages?.find((entry) => entry.messageId === messageId)
      const text = message ? queuedMessageEditableText(message.body) : null
      if (!message || text === null) {
        return false
      }
      const fingerprint = agentSessionSendBodyFingerprint(sessionId, message.body)
      const edit: Edit = {
        scope: sessionKey,
        messageId,
        body: message.body,
        originalText: text,
        text,
        fingerprint,
        acquiring: true,
        saving: false,
        keepText: latest.current.captureComposerTextAppender(),
        lease: startMobileQueuedEditLease({
          client,
          sessionId,
          messageId,
          expectedBodyFingerprint: fingerprint
        })
      }
      render(edit)
      const answer = await edit.lease.acquired.catch(() => undefined)
      if (!isOpen(active, edit)) {
        return false
      }
      if (answer && answer.status !== 'held') {
        if (answer.status === 'not-editable') {
          onSendError("This message can't be edited.")
        }
        close()
        return false
      }
      edit.acquiring = false
      render(edit)
      return true
    },
    [client, close, enabled, onSendError, render, sessionId, sessionKey]
  )
  const change = useCallback(
    (text: string) => {
      const edit = active.current
      if (edit && !edit.acquiring && !edit.saving) {
        edit.text = text
        render(edit)
      }
    },
    [render]
  )
  const save = useCallback(async (): Promise<boolean> => {
    const edit = active.current
    if (!edit || edit.acquiring || edit.saving || !sessionId) {
      return false
    }
    const body = queuedMessageWithEditedText(edit.body, edit.text)
    if (!body) {
      return false
    }
    edit.saving = true
    render(edit)
    const result = await mutate<AgentSessionQueuedMessageUpdateResult>(
      'agentSession.queuedMessageUpdate',
      'agentSession.queuedMessageUpdate',
      { messageId: edit.messageId, expectedBodyFingerprint: edit.fingerprint, text: edit.text }
    )
    if (!isOpen(active, edit)) {
      return false
    }
    edit.saving = false
    if (result.status === 'accepted') {
      if (result.value.status === 'updated' || result.value.status === 'unchanged') {
        close()
        onActionResolved?.()
        return true
      }
      if (result.value.status === 'gone' || result.value.status === 'changed') {
        recover(edit, result.value.status)
        return false
      }
      onSendError("This message can't be edited.")
    }
    render(edit)
    return false
  }, [close, mutate, onActionResolved, onSendError, recover, render, sessionId])

  // An absent list proves nothing; a published update settles a Save whose reply was lost.
  useEffect(() => {
    const edit = active.current
    if (!edit || edit.scope !== sessionKey || edit.saving || args.messages === null || !sessionId) {
      return
    }
    const body = queuedMessageWithEditedText(edit.body, edit.text)
    const desired = body ? agentSessionSendBodyFingerprint(sessionId, body) : null
    const listed = args.messages.find((message) => message.messageId === edit.messageId)
    const sent = args.submissions.some(
      (entry) => entry.queuedMessageId === edit.messageId && entry.payloadFingerprint === desired
    )
    if (!listed || !args.cards.some((card) => card.messageId === edit.messageId)) {
      if (sent) {
        close()
      } else {
        recover(edit, 'gone')
      }
    } else if (
      desired !== edit.fingerprint &&
      agentSessionSendBodyFingerprint(sessionId, listed.body) === desired
    ) {
      close()
    }
  }, [args.cards, args.messages, args.submissions, close, recover, sessionId, sessionKey, shown])

  const editor: MobileQueuedMessageInlineEditor | undefined =
    shown?.scope === sessionKey
      ? {
          messageId: shown.messageId,
          text: shown.text,
          acquiring: shown.acquiring,
          saving: shown.saving,
          canSave: queuedMessageWithEditedText(shown.body, shown.text) !== null,
          change,
          save,
          cancel: close
        }
      : undefined
  return { begin, editor }
}

function isOpen(active: { current: Edit | null }, edit: Edit): boolean {
  return active.current === edit
}
