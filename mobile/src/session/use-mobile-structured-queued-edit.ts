import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageUpdateResult
} from '../../../src/shared/agent-session-wire'
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
  text: string
  fingerprint: string
  saving: boolean
  lease: MobileQueuedEditLease
}

export function useMobileStructuredQueuedEdit(args: {
  sessionKey: string
  sessionId: string | null
  client: RpcClient | null
  chatActive: boolean
  enabled: boolean
  messages: readonly AgentSessionQueuedMessage[] | null
  cards: readonly MobileQueuedMessageCard[]
  mutate: MobileStructuredAgentMutate
  onSendError: (text: string) => void
  onActionResolved?: () => void
}) {
  const { sessionKey, sessionId, client, enabled, mutate, onSendError, onActionResolved } = args
  const clientRef = useRef({ sessionKey, client })
  useLayoutEffect(() => {
    clientRef.current = { sessionKey, client }
  }, [client, sessionKey])
  const active = useRef<Edit | null>(null)
  const [shown, setShown] = useState<Edit | null>(null)
  const render = useCallback((edit: Edit | null) => {
    active.current = edit
    setShown(edit ? { ...edit } : null)
  }, [])
  const close = useCallback(() => {
    const edit = active.current
    render(null)
    edit?.lease.end()
  }, [render])

  useEffect(() => {
    return () => {
      const edit = active.current
      active.current = null
      setShown(null)
      edit?.lease.end()
    }
  }, [sessionKey, args.chatActive])

  const begin = useCallback(
    async (messageId: string): Promise<boolean> => {
      if (active.current || !enabled || !client || !sessionId) {
        return false
      }
      const message = args.messages?.find((entry) => entry.messageId === messageId)
      const text = message ? queuedMessageEditableText(message.body) : null
      if (!message || text === null) {
        return false
      }
      const fingerprint = agentSessionSendBodyFingerprint(sessionId, message.body)
      const edit: Edit = {
        scope: sessionKey,
        messageId,
        body: message.body,
        text,
        fingerprint,
        saving: false,
        lease: startMobileQueuedEditLease({
          getClient: () =>
            clientRef.current.sessionKey === sessionKey ? clientRef.current.client : client,
          sessionId,
          messageId,
          expectedBodyFingerprint: fingerprint
        })
      }
      render(edit)
      void edit.lease.acquired.then(
        (answer) => {
          if (!isOpen(active, edit) || edit.saving) {
            return
          }
          if (answer.status === 'gone') {
            close()
          } else if (answer.status === 'changed') {
            onSendError('This message changed while you were editing.')
          } else if (answer.status === 'not-editable') {
            onSendError("This message can't be edited.")
          }
        },
        () => undefined
      )
      return true
    },
    [args.messages, client, close, enabled, onSendError, render, sessionId, sessionKey]
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
    if (!edit || edit.saving || !sessionId || !queuedMessageWithEditedText(edit.body, edit.text)) {
      return false
    }
    edit.saving = true
    render(edit)
    const result = await mutate<AgentSessionQueuedMessageUpdateResult>(
      'agentSession.queuedMessageUpdate',
      'agentSession.queuedMessageUpdate',
      { messageId: edit.messageId, expectedBodyFingerprint: edit.fingerprint, text: edit.text },
      () => isOpen(active, edit)
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
      if (result.value.status === 'gone') {
        close()
        return false
      }
      onSendError(
        result.value.status === 'changed'
          ? 'This message changed while you were editing.'
          : "This message can't be edited."
      )
    }
    render(edit)
    return false
  }, [close, mutate, onActionResolved, onSendError, render, sessionId])

  useEffect(() => {
    const edit = active.current
    if (
      !edit ||
      edit.scope !== sessionKey ||
      args.messages === null ||
      (args.messages.some((message) => message.messageId === edit.messageId) &&
        args.cards.some((card) => card.messageId === edit.messageId))
    ) {
      return
    }
    close()
  }, [args.cards, args.messages, close, sessionKey, shown])

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
