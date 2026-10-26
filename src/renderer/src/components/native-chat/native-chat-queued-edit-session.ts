import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  nativeChatQueuedEditDirty,
  handBackNativeChatQueuedEdit
} from './native-chat-queued-edit-draft'
import { subscribeToNativeChatComposerDraft } from './native-chat-composer-draft-store'
import { subscribeToNativeChatPendingAttachments } from './native-chat-pending-attachment-cache'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { NativeChatQueuedEditDraft } from './native-chat-queued-edit-draft'
import type { QueuedEditLease } from './structured-agent-session-queued-edit-lease'
import type { QueuedMessageCard } from './structured-agent-session-queued-cards'
import type { StructuredAgentSessionWrite } from './use-structured-agent-session-mutate'

export type QueuedEditTransport = {
  target: RuntimeClientTarget
  sessionId: string
  /** The host advertises `agent-session.queued-message-edit.v1`; without it there is no Edit. */
  capable: boolean
  /** The host advertises `agent-session.queued-message-image-edit.v1`: Save may replace images. */
  imagesCapable?: boolean
  skillsCapable?: boolean
  write: StructuredAgentSessionWrite
}

export type QueuedMessageInlineEditor = {
  messageId: string
  draftScopeKey: string
  text: string
  change: (text: string) => void
  acquiring: boolean
  saving: boolean
  canSave: boolean
  imagesCapable: boolean
  save: () => void
  cancel: () => void
}

export type NativeChatQueuedEditSession = NativeChatQueuedEditDraft & {
  scope: string
  messageId: string
  /** The body Save expects to replace; fixed for the edit, so a newer text is never overwritten. */
  baseFingerprint: string
  acquiring: boolean
  saving: boolean
  closed: boolean
  pendingClose: boolean
  view: {
    messages: readonly AgentSessionQueuedMessage[] | null
    cards: readonly QueuedMessageCard[]
    submissions: readonly AgentJournalSubmission[]
    promptOpen: boolean
  }
  lease: QueuedEditLease
}

export function useNativeChatQueuedEditLifetime({
  scope,
  shownScope,
  active,
  reopen,
  close,
  render
}: {
  scope: string
  shownScope: string | undefined
  active: { current: NativeChatQueuedEditSession | null }
  reopen: { current: { scope: string; messageId: string; stale: string } | null }
  close: (edit?: NativeChatQueuedEditSession | null) => void
  render: (edit: NativeChatQueuedEditSession | null) => void
}) {
  // On chat/host/composer changes, unmount or reload, hand unsaved typing back to its original chat.
  useEffect(() => {
    const handOff = (): void => {
      const edit = active.current
      active.current = null
      reopen.current = null
      if (!edit) {
        return
      }
      if (edit.saving) {
        edit.pendingClose = true
        return
      }
      if (nativeChatQueuedEditDirty(edit) && handBackNativeChatQueuedEdit(edit)) {
        toast.error(
          translate(
            'components.native-chat.queuedMessages.editReturned',
            'Your edit is in the chat box.'
          )
        )
      }
      close(edit)
    }
    window.addEventListener('pagehide', handOff)
    return () => {
      window.removeEventListener('pagehide', handOff)
      handOff()
    }
  }, [scope, close, active, reopen])

  useEffect(() => {
    if (!shownScope) {
      return
    }
    const update = (): void => {
      if (active.current) {
        render(active.current)
      }
    }
    const unsubscribe = subscribeToNativeChatComposerDraft(shownScope, update)
    const unpending = subscribeToNativeChatPendingAttachments(shownScope, update)
    return () => {
      unsubscribe()
      unpending()
    }
  }, [shownScope, render, active])
}
