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
import { startMobileQueuedEditLease } from './mobile-queued-message-edit-lease'
import {
  detachQueuedEditSave,
  detachedQueuedEditPublication,
  detachedQueuedEditSave,
  forgetDetachedQueuedEditSave,
  settleDetachedQueuedEditSave,
  type MobileQueuedEditSave
} from './mobile-queued-edit-save-owner'
import type { MobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'
import type { MobileQueuedMessageCard } from './mobile-structured-queued-message-cards'

export type MobileQueuedMessageInlineEditor = {
  messageId: string
  text: string
  saving: boolean
  canSave: boolean
  change: (text: string) => void
  save: () => Promise<boolean>
  cancel: () => void
}

type Edit = MobileQueuedEditSave

export function useMobileStructuredQueuedEdit(args: {
  sessionKey: string
  sessionId: string | null
  client: RpcClient | null
  enabled: boolean
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
  const [detachedRevision, revisitDetached] = useState(0)
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
    (edit: Edit, reason: 'changed' | 'gone' | 'not-editable') => {
      if (edit.text !== edit.originalText && edit.keepText?.(edit.text)) {
        const message =
          reason === 'changed'
            ? 'This message changed while you were editing.'
            : reason === 'gone'
              ? 'This message was already sent or removed.'
              : "This message can't be edited."
        onSendError(`${message} Your edit is in the chat box.`)
      } else if (reason === 'not-editable') {
        onSendError("This message can't be edited.")
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
      if (edit?.saving) {
        detachQueuedEditSave(edit)
      } else if (edit && edit.text !== edit.originalText) {
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
        sessionId,
        messageId,
        body: message.body,
        originalText: text,
        text,
        fingerprint,
        publication: latest.current.messages,
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
      void edit.lease.acquired.then(
        (answer) => {
          if (
            !isOpen(active, edit) ||
            edit.saving ||
            (answer.status !== 'changed' &&
              answer.status !== 'gone' &&
              answer.status !== 'not-editable')
          ) {
            return
          }
          recover(edit, answer.status)
        },
        () => undefined
      )
      return true
    },
    [client, enabled, recover, render, sessionId, sessionKey]
  )
  const change = useCallback(
    (text: string) => {
      const edit = active.current
      if (edit && !edit.saving) {
        edit.text = text
        render(edit)
      }
    },
    [render]
  )
  const save = useCallback(async (): Promise<boolean> => {
    const edit = active.current
    if (!edit || edit.saving || !sessionId) {
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
    edit.saving = false
    if (!isOpen(active, edit)) {
      const outcome = settleDetachedQueuedEditSave(edit, result)
      if (outcome === 'unknown' && latest.current.sessionKey === edit.scope) {
        revisitDetached((revision) => revision + 1)
      }
      return outcome === 'saved'
    }
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
      recover(edit, 'not-editable')
      return false
    }
    render(edit)
    return false
  }, [close, mutate, onActionResolved, recover, render, sessionId])

  // A lost reply is settled from the next published view of the originating queue.
  useEffect(() => {
    const pending = detachedQueuedEditSave(sessionKey)
    if (!pending || pending.saving || active.current || !sessionId || !client || !enabled) {
      return
    }
    const outcome = detachedQueuedEditPublication({
      edit: pending,
      messages: args.messages,
      cards: args.cards,
      submissions: args.submissions
    })
    if (outcome === 'wait') {
      return
    }
    forgetDetachedQueuedEditSave(sessionKey)
    if (outcome === 'saved') {
      return
    }
    if (outcome === 'restore') {
      if (pending.text !== pending.originalText) {
        pending.keepText?.(pending.text)
      }
      return
    }
    pending.lease = startMobileQueuedEditLease({
      client,
      sessionId,
      messageId: pending.messageId,
      expectedBodyFingerprint: pending.fingerprint
    })
    render(pending)
    void pending.lease.acquired.then(
      (answer) => {
        if (
          isOpen(active, pending) &&
          !pending.saving &&
          (answer.status === 'changed' ||
            answer.status === 'gone' ||
            answer.status === 'not-editable')
        ) {
          recover(pending, answer.status)
        }
      },
      () => undefined
    )
  }, [
    args.cards,
    args.messages,
    args.submissions,
    client,
    detachedRevision,
    enabled,
    recover,
    render,
    sessionId,
    sessionKey
  ])

  // An absent list proves nothing; a published update settles a Save whose reply was lost.
  useEffect(() => {
    const edit = active.current
    if (edit?.scope === sessionKey) {
      edit.publication = args.messages
    }
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
          saving: shown.saving,
          canSave: queuedMessageWithEditedText(shown.body, shown.text) !== null,
          change,
          save,
          cancel: () => {
            if (!active.current?.saving) {
              close()
            }
          }
        }
      : undefined
  return { begin, editor }
}

function isOpen(active: { current: Edit | null }, edit: Edit): boolean {
  return active.current === edit
}
