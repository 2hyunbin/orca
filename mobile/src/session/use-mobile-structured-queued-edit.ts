import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageUpdateResult
} from '../../../src/shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../src/shared/structured-agent-session-send-mutation'
import {
  queuedEditDirty,
  queuedEditInput,
  queuedEditKeptImages,
  queuedEditSaveHeld,
  queuedMessageEditableText,
  queuedMessageWithEdit
} from '../../../src/shared/queued-message-edit'
import type { RpcClient } from '../transport/rpc-client'
import {
  startMobileQueuedEditLease,
  type MobileQueuedEditLease
} from './mobile-queued-message-edit-lease'
import type { MobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'
import type { MobileQueuedMessageCard } from './mobile-structured-queued-message-cards'
import {
  handOffMobileQueuedEdit,
  mobileQueuedEditImageEditor,
  useMobileQueuedEditImageActions,
  type MobileQueuedEditComposerImages,
  type MobileQueuedEditImagesEditor,
  type MobileQueuedEditImageState
} from './mobile-queued-edit-images'

export type MobileQueuedMessageInlineEditor = {
  messageId: string
  text: string
  saving: boolean
  canSave: boolean
  change: (text: string) => void
  save: () => Promise<boolean>
  cancel: () => void
  /** Present when the host can replace the card's images; absent, the editor edits text only. */
  images?: MobileQueuedEditImagesEditor
}

type Edit = MobileQueuedEditImageState & {
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
  appendComposerText: ((text: string) => boolean) | undefined
  /** The host advertises `agent-session.queued-message-image-edit.v1`: Save may replace images. */
  imagesCapable?: boolean
  acceptsImages?: boolean
  onSendError: (text: string) => void
  onActionResolved?: () => void
}) {
  const { sessionKey, sessionId, client, enabled, mutate, onSendError, onActionResolved } = args
  const imagesCapable = args.imagesCapable === true
  const clientRef = useRef({ sessionKey, client })
  useLayoutEffect(() => {
    clientRef.current = { sessionKey, client }
  }, [client, sessionKey])
  const active = useRef<Edit | null>(null)
  const abandoned = useRef(0)
  /** Save answered `changed`: the editor reopens on the newer text once the card shows it. */
  const reopen = useRef<{
    scope: string
    messageId: string
    stale: string
    composerImages?: MobileQueuedEditComposerImages
  } | null>(null)
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
      abandoned.current += 1
      reopen.current = null
      close()
    }
  }, [sessionKey, args.chatActive, close])

  const gone = useCallback(
    (edit: Edit) => {
      if (
        !edit.saving &&
        queuedEditDirty(edit.body, edit) &&
        handOffMobileQueuedEdit(edit, args.appendComposerText)
      ) {
        onSendError('This message is no longer queued. Your edit is in the chat box.')
      }
      close()
    },
    [args.appendComposerText, close, onSendError]
  )

  const begin = useCallback(
    async (
      messageId: string,
      composerImages?: MobileQueuedEditComposerImages
    ): Promise<boolean> => {
      reopen.current = null
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
        kept: queuedEditKeptImages(message.body),
        added: [],
        composerImages,
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
          if (active.current !== edit || edit.saving) {
            return
          }
          if (answer.status === 'gone') {
            gone(edit)
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
    [args.messages, client, enabled, gone, onSendError, render, sessionId, sessionKey]
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
  const images = useMobileQueuedEditImageActions(active, render)
  const save = useCallback(async (): Promise<boolean> => {
    const edit = active.current
    if (!edit || edit.saving || queuedEditSaveHeld(edit.body, edit, imagesCapable) || !sessionId) {
      return false
    }
    const input = queuedEditInput(edit.body, edit, imagesCapable)
    if (!queuedMessageWithEdit(edit.body, input).ok) {
      return false
    }
    if (!queuedEditDirty(edit.body, edit)) {
      close()
      return true
    }
    const epoch = abandoned.current
    edit.saving = true
    render(edit)
    const result = await mutate<AgentSessionQueuedMessageUpdateResult>(
      'agentSession.queuedMessageUpdate',
      'agentSession.queuedMessageUpdate',
      {
        messageId: edit.messageId,
        expectedBodyFingerprint: edit.fingerprint,
        text: input.text,
        ...(input.images ? { images: input.images } : {})
      },
      () => active.current === edit
    )
    // A reply landing mid chat switch belongs to the chat being left.
    if (abandoned.current !== epoch || clientRef.current.sessionKey !== edit.scope) {
      return false
    }
    edit.saving = false
    if (
      result.status === 'accepted' &&
      (result.value.status === 'updated' || result.value.status === 'unchanged')
    ) {
      if (active.current === edit) {
        close()
      }
      onActionResolved?.()
      return true
    }
    if (active.current !== edit) {
      if (handOffMobileQueuedEdit(edit, args.appendComposerText)) {
        onSendError(
          result.status === 'unknown'
            ? "Couldn't confirm Save. Your edit is in the chat box; check before sending it again."
            : "Couldn't save this queued message. Your edit is in the chat box."
        )
      }
      return false
    }
    if (result.status === 'accepted') {
      if (result.value.status === 'gone') {
        gone(edit)
        return false
      }
      if (result.value.status === 'changed') {
        const handedOff = handOffMobileQueuedEdit(edit, args.appendComposerText)
        onSendError(
          handedOff
            ? 'This message changed while you were editing. Your edit is in the chat box.'
            : 'This message changed while you were editing.'
        )
        reopen.current = {
          scope: edit.scope,
          messageId: edit.messageId,
          stale: edit.fingerprint,
          composerImages: edit.composerImages
        }
        close()
        return false
      }
      onSendError("This message can't be edited.")
    }
    render(edit)
    return false
  }, [
    args.appendComposerText,
    close,
    gone,
    imagesCapable,
    mutate,
    onActionResolved,
    onSendError,
    render,
    sessionId
  ])

  useEffect(() => {
    const edit = active.current
    const listed = (messageId: string): boolean =>
      args.messages?.some((message) => message.messageId === messageId) === true &&
      args.cards.some((card) => card.messageId === messageId)
    if (edit && edit.scope === sessionKey && args.messages !== null && !listed(edit.messageId)) {
      gone(edit)
    }
    const pending = reopen.current
    if (!pending || active.current || args.messages === null || !sessionId) {
      return
    }
    const message = args.messages.find((entry) => entry.messageId === pending.messageId)
    if (pending.scope !== sessionKey || !message || !listed(pending.messageId)) {
      reopen.current = null
    } else if (agentSessionSendBodyFingerprint(sessionId, message.body) !== pending.stale) {
      void begin(pending.messageId, pending.composerImages)
    }
  }, [args.cards, args.messages, begin, gone, sessionId, sessionKey, shown])

  const edited =
    shown && queuedMessageWithEdit(shown.body, queuedEditInput(shown.body, shown, imagesCapable))
  const editor: MobileQueuedMessageInlineEditor | undefined =
    shown && edited && shown.scope === sessionKey
      ? {
          messageId: shown.messageId,
          text: shown.text,
          saving: shown.saving,
          canSave: edited.ok && !queuedEditSaveHeld(shown.body, shown, imagesCapable),
          images: imagesCapable
            ? mobileQueuedEditImageEditor(shown, args.acceptsImages, images)
            : undefined,
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
