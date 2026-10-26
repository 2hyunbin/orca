import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageUpdateResult
} from '../../../src/shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../src/shared/structured-agent-session-send-mutation'
import {
  queuedMessageEditableText,
  queuedMessageWithEdit
} from '../../../src/shared/queued-message-edit'
import { createUuidV4 } from '../../../src/shared/uuid-v4'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import type { RpcClient } from '../transport/rpc-client'
import { startMobileQueuedEditLease } from './mobile-queued-message-edit-lease'
import type { MobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'
import type { MobileQueuedMessageCard } from './mobile-structured-queued-message-cards'
import { useMobileNativeChatDraftInputs } from './native-chat/composer/mobile-native-chat-draft-inputs'
import {
  closeMobileQueuedEditDraft,
  seedMobileQueuedEditInputs,
  serializeMobileQueuedEdit,
  mobileQueuedEditSaveHeld,
  removeMobileQueuedEditImage,
  type MobileQueuedEditDraft as Edit,
  type MobileQueuedMessageInlineEditor
} from './mobile-queued-message-edit-draft'
export type { MobileQueuedMessageInlineEditor } from './mobile-queued-message-edit-draft'

export function useMobileStructuredQueuedEdit(args: {
  sessionKey: string
  sessionId: string | null
  client: RpcClient | null
  chatActive: boolean
  enabled: boolean
  imagesCapable?: boolean
  skillsCapable?: boolean
  composerScopeKey?: string | null
  messages: readonly AgentSessionQueuedMessage[] | null
  submissions?: readonly AgentJournalSubmission[]
  cards: readonly MobileQueuedMessageCard[]
  mutate: MobileStructuredAgentMutate
  appendComposerText: ((text: string) => boolean) | undefined
  onQueuedEditNotice?: (text: string) => void
  onSendError: (text: string) => void
  onActionResolved?: () => void
}) {
  const { sessionKey, sessionId, client, enabled, mutate, onSendError, onActionResolved } = args
  const active = useRef<Edit | null>(null)
  const [shown, setShown] = useState<Edit | null>(null)
  const latest = useRef(args)
  useLayoutEffect(() => {
    latest.current = args
    const edit = active.current
    if (edit?.scope === args.sessionKey) {
      edit.published = { messages: args.messages, submissions: args.submissions ?? [] }
    }
  })
  useMobileNativeChatDraftInputs(shown?.scopeKey ?? null)
  const render = useCallback((edit: Edit | null) => {
    active.current = edit
    setShown(edit ? { ...edit } : null)
  }, [])
  const close = useCallback(
    (edit: Edit, handBack = false) => {
      closeMobileQueuedEditDraft(edit, handBack, latest.current.onQueuedEditNotice)
      if (active.current === edit) {
        render(null)
      }
    },
    [render]
  )

  useEffect(
    () => () => {
      const edit = active.current
      if (!edit) {
        return
      }
      // A submitted snapshot owns its reply even across navigation; no publication duplicates it.
      if (edit.saving) {
        edit.pendingClose = true
        active.current = null
        return
      }
      close(edit, true)
    },
    [sessionKey, args.chatActive, close]
  )

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
      const scopeKey = `queued-edit:${createUuidV4()}`
      seedMobileQueuedEditInputs(scopeKey, message.body)
      const edit: Edit = {
        scope: sessionKey,
        client,
        sessionId,
        published: { messages: args.messages, submissions: args.submissions ?? [] },
        scopeKey,
        destination: args.composerScopeKey ?? null,
        handBackText: args.appendComposerText,
        messageId,
        body: message.body,
        text,
        fingerprint,
        saving: false,
        closed: false,
        handedBack: false,
        pendingClose: false,
        lease: startMobileQueuedEditLease({
          getClient: () =>
            latest.current.sessionKey === sessionKey ? latest.current.client : client,
          sessionId,
          messageId,
          expectedBodyFingerprint: fingerprint
        })
      }
      render(edit)
      void edit.lease.acquired.then(
        (answer) => {
          if (edit.closed || edit.saving) {
            return
          }
          if (answer.status === 'gone' || answer.status === 'changed') {
            close(edit, true)
          } else if (answer.status === 'not-editable') {
            onSendError("This message can't be edited.")
            close(edit, true)
          }
        },
        () => undefined
      )
      return true
    },
    [
      args.appendComposerText,
      args.composerScopeKey,
      args.messages,
      client,
      close,
      enabled,
      onSendError,
      render,
      sessionId,
      sessionKey
    ]
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
    if (mobileQueuedEditSaveHeld(edit, args.imagesCapable)) {
      return false
    }
    const fields = serializeMobileQueuedEdit(edit, args.imagesCapable, args.skillsCapable)
    const desired = queuedMessageWithEdit(edit.body, fields)
    if (!desired.ok) {
      return false
    }
    const fingerprint = agentSessionSendBodyFingerprint(sessionId, desired.body)
    if (fingerprint === edit.fingerprint) {
      close(edit)
      return true
    }
    edit.saving = true
    edit.submittedFingerprint = fingerprint
    render(edit)
    const result = await mutate<AgentSessionQueuedMessageUpdateResult>(
      'agentSession.queuedMessageUpdate',
      'agentSession.queuedMessageUpdate',
      { messageId: edit.messageId, expectedBodyFingerprint: edit.fingerprint, ...fields },
      () =>
        !edit.closed &&
        !edit.pendingClose &&
        (edit.published.messages === null ||
          edit.published.messages.some(({ messageId }) => messageId === edit.messageId))
    )
    edit.saving = false
    if (result.status === 'accepted') {
      const status = result.value.status
      if (status === 'updated' || status === 'unchanged') {
        close(edit)
        if (!edit.pendingClose) {
          onActionResolved?.()
        }
        return true
      }
      if (status === 'gone' || status === 'changed') {
        close(edit, true)
        return false
      }
      onSendError("This message can't be edited.")
    } else {
      const { messages, submissions } = edit.published
      const message = messages?.find(({ messageId }) => messageId === edit.messageId)
      if (
        (message &&
          agentSessionSendBodyFingerprint(edit.sessionId, message.body) === fingerprint) ||
        submissions.some(
          (entry) =>
            entry.queuedMessageId === edit.messageId && entry.payloadFingerprint === fingerprint
        )
      ) {
        close(edit)
        return true
      }
      if (messages !== null && !message) {
        close(edit, true)
        return false
      }
    }
    if (edit.pendingClose) {
      close(edit, true)
    } else if (active.current === edit) {
      render(edit)
    }
    return false
  }, [
    args.imagesCapable,
    args.skillsCapable,
    close,
    mutate,
    onActionResolved,
    onSendError,
    render,
    sessionId
  ])

  useEffect(() => {
    const edit = active.current
    if (!edit || edit.saving || edit.scope !== sessionKey || args.messages === null) {
      return
    }
    const message = args.messages.find(({ messageId }) => messageId === edit.messageId)
    if (
      edit.submittedFingerprint &&
      ((message &&
        agentSessionSendBodyFingerprint(edit.sessionId, message.body) ===
          edit.submittedFingerprint) ||
        args.submissions?.some(
          (entry) =>
            entry.queuedMessageId === edit.messageId &&
            entry.payloadFingerprint === edit.submittedFingerprint
        ))
    ) {
      close(edit)
    } else if (!message || !args.cards.some(({ messageId }) => messageId === edit.messageId)) {
      close(edit, true)
    }
  }, [args.cards, args.messages, args.submissions, close, sessionKey])

  const editor: MobileQueuedMessageInlineEditor | undefined =
    shown?.scope === sessionKey
      ? {
          messageId: shown.messageId,
          scopeKey: shown.scopeKey,
          client: shown.client,
          sessionId: shown.sessionId,
          imagesCapable: args.imagesCapable === true,
          text: shown.text,
          saving: shown.saving,
          canSave:
            !mobileQueuedEditSaveHeld(shown, args.imagesCapable) &&
            queuedMessageWithEdit(
              shown.body,
              serializeMobileQueuedEdit(shown, args.imagesCapable, args.skillsCapable)
            ).ok,
          change,
          removeImage: (id) => {
            const edit = active.current
            if (!edit || edit.saving || !args.imagesCapable) {
              return
            }
            removeMobileQueuedEditImage(edit, id)
            render(edit)
          },
          save,
          cancel: () => {
            if (active.current && !active.current.saving) {
              close(active.current)
            }
          }
        }
      : undefined
  return { begin, editor }
}
