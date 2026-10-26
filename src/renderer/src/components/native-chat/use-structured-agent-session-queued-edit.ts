import { promptMarkersToImageReferences } from '../../../../shared/native-chat-image-transcript-markers'
import { nativeChatImageRowIds } from './native-chat-composer-image-references'
// Edit inside the card while prompts own the composer; host owns durable content, this pane owns typing, a delivery hold lease and compare-and-set Save.

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { structuredAgentSessionHostKey } from '@/runtime/structured-agent-session-host-capability'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageUpdateResult
} from '../../../../shared/agent-session-wire'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../../../shared/structured-agent-session-send-mutation'
import {
  queuedMessageEditableText,
  queuedMessageWithEdit
} from '../../../../shared/queued-message-edit'
import { queuedEditChangedNotice, queuedEditNotice } from './queued-message-edit-notices'
import {
  createNativeChatQueuedEditDraft,
  discardNativeChatQueuedEdit,
  handBackNativeChatQueuedEdit,
  nativeChatQueuedEditDirty,
  nativeChatQueuedEditHeld,
  nativeChatQueuedEditInput
} from './native-chat-queued-edit-draft'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { structuredSessionOperationId } from './structured-agent-session-operation-id'
import { startQueuedEditLease } from './structured-agent-session-queued-edit-lease'
import type { QueuedMessageCard } from './structured-agent-session-queued-cards'
import {
  queuedCardOnScreen,
  queuedEditStanding
} from './structured-agent-session-queued-edit-standing'
import { useNativeChatQueuedEditLifetime } from './native-chat-queued-edit-session'
import type {
  QueuedEditTransport,
  QueuedMessageInlineEditor,
  NativeChatQueuedEditSession as Edit
} from './native-chat-queued-edit-session'
export type {
  QueuedEditTransport,
  QueuedMessageInlineEditor
} from './native-chat-queued-edit-session'

export function useStructuredAgentSessionQueuedEdit(args: {
  transport: QueuedEditTransport
  /** The host's published cards, for each card's full body. */
  messages: readonly AgentSessionQueuedMessage[] | null
  /** The cards this pane shows; a card that leaves them has left the queue. */
  cards: readonly QueuedMessageCard[]
  submissions: readonly AgentJournalSubmission[]
  composerScopeKey: string | undefined
  /** A question or approval holds the chat box's place. */
  promptOpen: boolean
}) {
  const { transport, messages, cards, submissions, composerScopeKey, promptOpen } = args
  const { target, sessionId, capable, write } = transport
  const imagesCapable = transport.imagesCapable === true
  const scope = `${structuredAgentSessionHostKey(target)}:${sessionId}:${composerScopeKey ?? ''}`
  const active = useRef<Edit | null>(null)
  const [shown, setShown] = useState<Edit | null>(null)
  /** Save answered `changed`: the editor reopens on the newer text once this pane shows it. */
  const reopen = useRef<{ scope: string; messageId: string; stale: string } | null>(null)
  const latest = useRef({ messages, cards, submissions, promptOpen })
  useEffect(() => {
    latest.current = { messages, cards, submissions, promptOpen }
    if (active.current?.scope === scope) {
      active.current.view = latest.current
    }
  }, [messages, cards, submissions, promptOpen, scope])

  const render = useCallback((edit: Edit | null) => {
    active.current = edit
    setShown(edit ? { ...edit } : null)
  }, [])
  const close = useCallback(
    (edit = active.current) => {
      if (!edit || edit.closed) {
        return
      }
      edit.closed = true
      if (active.current === edit) {
        render(null)
      }
      edit.lease.end()
      discardNativeChatQueuedEdit(edit)
    },
    [render]
  )
  /** Return dirty text to its conversation’s composer after existing draft content when the card leaves the queue. */
  const gone = useCallback(
    (edit: Edit) => {
      if (edit.closed) {
        return
      }
      if (nativeChatQueuedEditDirty(edit) && handBackNativeChatQueuedEdit(edit)) {
        toast.error(queuedEditNotice(edit.view.promptOpen ? 'editGonePrompt' : 'editGone'))
      }
      close(edit)
    },
    [close]
  )

  useNativeChatQueuedEditLifetime({
    scope,
    shownScope: shown?.scopeKey,
    active,
    reopen,
    close,
    render
  })

  const begin = useCallback(
    async (messageId: string): Promise<void> => {
      // One editor per pane: another card's Edit waits for this one's Save or Cancel.
      reopen.current = null
      if (active.current || !capable || !composerScopeKey) {
        return
      }
      const message = messages?.find((entry) => entry.messageId === messageId)
      const text = message ? queuedMessageEditableText(message.body) : null
      if (!message || text === null) {
        return
      }
      const baseFingerprint = agentSessionSendBodyFingerprint(sessionId, message.body)
      const lease = startQueuedEditLease({
        target,
        sessionId,
        messageId,
        editId: structuredSessionOperationId(),
        expectedBodyFingerprint: baseFingerprint
      })
      const edit: Edit = {
        scope,
        ...createNativeChatQueuedEditDraft(message.body, composerScopeKey),
        messageId,
        body: message.body,
        baseFingerprint,
        acquiring: true,
        saving: false,
        closed: false,
        pendingClose: false,
        view: latest.current,
        lease
      }
      render(edit)
      const answer = await lease.acquired.catch(() => null)
      if (!isOpen(active, edit)) {
        return
      }
      if (answer?.status === 'gone' || answer?.status === 'changed') {
        // Sent, removed or edited elsewhere before the edit began: the card shows what happened.
        close()
      } else if (answer?.status === 'not-editable') {
        toast.error(queuedEditNotice('editFailed'))
        close()
      } else {
        // An unanswered lease never gates typing: the lease keeps trying, and Save checks the text.
        edit.acquiring = false
        render(edit)
      }
    },
    [capable, close, composerScopeKey, messages, render, scope, sessionId, target]
  )

  const save = useCallback(async () => {
    const edit = active.current
    if (!edit || edit.acquiring || edit.saving) {
      return
    }
    if (!nativeChatQueuedEditDirty(edit)) {
      close()
      return
    }
    const input = nativeChatQueuedEditInput(edit, imagesCapable, transport.skillsCapable === true)
    const edited = queuedMessageWithEdit(edit.body, input)
    if (!edited.ok || nativeChatQueuedEditHeld(edit, imagesCapable)) {
      return
    }
    edit.saving = true
    render(edit)
    const result = await write<AgentSessionQueuedMessageUpdateResult>(
      'agentSession.queuedMessageUpdate',
      'agentSession.queuedMessageUpdate',
      {
        messageId: edit.messageId,
        expectedBodyFingerprint: edit.baseFingerprint,
        text: input.text,
        ...(input.images ? { images: input.images } : {}),
        ...(input.skills ? { skills: input.skills } : {})
      }
    )
    if (edit.closed) {
      return
    }
    edit.saving = false
    if (result.kind === 'done') {
      const { status } = result.value
      if (status === 'updated' || status === 'unchanged') {
        close(edit)
      } else if (status === 'gone') {
        gone(edit)
      } else if (status === 'changed') {
        // Preserve typing after a competing edit, then reopen on the newer text; removal alone needs no handoff.
        toast.error(
          queuedEditChangedNotice(handBackNativeChatQueuedEdit(edit), edit.view.promptOpen)
        )
        if (!edit.pendingClose) {
          reopen.current = { scope, messageId: edit.messageId, stale: edit.baseFingerprint }
        }
        close(edit)
      } else {
        if (edit.pendingClose) {
          gone(edit)
        } else {
          toast.error(queuedEditNotice('editFailed'))
          render(edit)
        }
      }
      return
    }
    // When Save’s reply is lost/unread, published card state proves whether its body landed; leaving the queue may mean delivery before or after Save.
    const desired = agentSessionSendBodyFingerprint(sessionId, edited.body)
    const standing = queuedEditStanding(edit.view, sessionId, edit.messageId, desired)
    if (standing === 'sent' || standing === 'holds') {
      close(edit)
    } else if (standing === 'gone' || edit.pendingClose) {
      gone(edit)
    } else {
      // A refusal says why; an unread answer leaves the editor as it was for Save again.
      if (standing === 'differs' && result.kind === 'not-done') {
        toast.error(result.notice)
      }
      render(edit)
    }
  }, [close, gone, imagesCapable, render, scope, sessionId, write, transport.skillsCapable])

  // Let in-flight Save decide delivery races; otherwise reconcile departures, but never infer them from an unloaded list.
  useEffect(() => {
    const edit = active.current
    if (edit && !edit.saving && messages !== null) {
      const typed = queuedMessageWithEdit(
        edit.body,
        nativeChatQueuedEditInput(edit, imagesCapable, transport.skillsCapable === true)
      )
      const desired = typed.ok ? agentSessionSendBodyFingerprint(sessionId, typed.body) : null
      const view = { messages, cards, submissions }
      const standing = queuedEditStanding(view, sessionId, edit.messageId, desired)
      // `holds`: the card already holds what is typed, as after a Save whose answer was lost.
      if (standing === 'sent' || (standing === 'holds' && desired !== edit.baseFingerprint)) {
        close()
      } else if (standing === 'gone') {
        gone(edit)
      }
    }
    const pending = reopen.current
    if (!pending || edit || messages === null) {
      return
    }
    const listed = messages.find((entry) => entry.messageId === pending.messageId)
    if (pending.scope !== scope || !listed || !queuedCardOnScreen(cards, pending.messageId)) {
      reopen.current = null
    } else if (agentSessionSendBodyFingerprint(sessionId, listed.body) !== pending.stale) {
      void begin(pending.messageId)
    }
  }, [
    begin,
    cards,
    close,
    gone,
    imagesCapable,
    messages,
    scope,
    sessionId,
    shown,
    submissions,
    transport.skillsCapable
  ])

  const typed =
    shown &&
    queuedMessageWithEdit(
      shown.body,
      nativeChatQueuedEditInput(shown, imagesCapable, transport.skillsCapable === true)
    )
  const editor: QueuedMessageInlineEditor | undefined =
    shown && typed && shown.scope === scope
      ? {
          messageId: shown.messageId,
          draftScopeKey: shown.scopeKey,
          text: readNativeChatComposerDraft(shown.scopeKey).text,
          change: (text) => {
            if (!shown.acquiring && !shown.saving) {
              updateNativeChatComposerDraft(
                shown.scopeKey,
                {
                  text: promptMarkersToImageReferences(text, nativeChatImageRowIds(shown.scopeKey)),
                  document: undefined
                },
                'immediate'
              )
            }
          },
          imagesCapable,
          acquiring: shown.acquiring,
          saving: shown.saving,
          canSave: typed.ok && !nativeChatQueuedEditHeld(shown, imagesCapable),
          save: () => void save(),
          cancel: () => close()
        }
      : undefined
  return { editor, begin, capable }
}

/** A read of the ref, not a narrowing: an await may have closed or replaced the edit. */
function isOpen(active: { current: Edit | null }, edit: Edit): boolean {
  return active.current === edit
}
