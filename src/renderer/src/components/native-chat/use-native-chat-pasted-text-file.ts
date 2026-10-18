// A long text paste into a structured chat attaches as a file the agent reads, as a dropped file
// does, so the message's size bound never meets a pasted log or diff.

import { useCallback } from 'react'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { measureUtf8ByteLength } from '../../../../shared/utf8-byte-limits'
import { structuredAgentSessionBlocksTooLarge } from '../../../../shared/rpc-contract/structured-agent-session-message-params'
import {
  nativeChatAttachFailedNotice,
  nativeChatAttachmentOwnerChangedNotice,
  prepareNativeChatSessionAttachmentUpload,
  type NativeChatAttachmentOwner
} from './native-chat-attachment-upload'
import { nativeChatAttachmentOwnerUnchanged } from './native-chat-resolved-path-ownership'
import type { NativeChatPendingAttachmentChips } from './native-chat-session-attachment-drop'

/** Pastes this large attach as a file, measured in characters or UTF-8 bytes. */
export const NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD = 32 * 1024

export function nativeChatPastedTextLabel(): string {
  return translate('components.native-chat.composer.pastedTextLabel', 'Pasted text')
}

function pastedTextTooLargeNotice(): string {
  return translate(
    'components.native-chat.composer.pastedTextTooLarge',
    'This paste would put your message over the 256 KB limit for one message. Shorten it, then paste again.'
  )
}

/** Whether a paste becomes a file: it is long, or inline it would push the message past its bound. */
export function nativeChatPasteWouldExceedMessage(text: string, draft: string): boolean {
  return structuredAgentSessionBlocksTooLarge([{ type: 'text', text: `${draft}${text}` }])
}

export function nativeChatPasteBecomesFile(text: string, draft: string): boolean {
  return (
    text.length >= NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD ||
    measureUtf8ByteLength(text, { stopAfterBytes: NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD - 1 })
      .exceededLimit ||
    nativeChatPasteWouldExceedMessage(text, draft)
  )
}

type PastedTextFileOwner = Extract<NativeChatAttachmentOwner, { kind: 'local' | 'runtime-session' }>

async function savePastedTextFile(
  owner: PastedTextFileOwner,
  text: string
): Promise<{ ok: true; path: string } | { ok: false; notice: string }> {
  if (owner.kind === 'local') {
    return { ok: true, path: await window.api.ui.savePastedTextAsFile({ text }) }
  }
  const prepared = await prepareNativeChatSessionAttachmentUpload(owner)
  if (!prepared.ok) {
    return prepared
  }
  const { environmentId, ...agentSessionAttachment } = prepared.target
  return {
    ok: true,
    path: await window.api.ui.savePastedTextAsFile({
      text,
      runtimeEnvironmentId: environmentId,
      agentSessionAttachment
    })
  }
}

/**
 * Returns the composer's text insertion for a paste: a long paste into a structured chat whose host
 * takes files saves as a file and lands as an `@path` reference, behind a pending chip that holds
 * Send. Elsewhere text goes in as typed, unless it could never be sent.
 */
export function useNativeChatPastedTextFile(args: {
  /** Null: not a structured chat, so the text goes to the agent's own input as typed. */
  chips: NativeChatPendingAttachmentChips | null
  draft: string
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
  insertTypedText: (text: string) => boolean
  setNotice: (notice: string | null, errorText?: string) => void
}): (text: string) => boolean {
  const { chips, draft, resolveAttachmentOwner, insertTypedText, setNotice } = args
  return useCallback(
    (text: string): boolean => {
      if (!chips || !nativeChatPasteBecomesFile(text, draft)) {
        return insertTypedText(text)
      }
      const owner = resolveAttachmentOwner()
      if (owner.kind !== 'local' && owner.kind !== 'runtime-session') {
        if (nativeChatPasteWouldExceedMessage(text, draft)) {
          setNotice(pastedTextTooLargeNotice())
          return true
        }
        return insertTypedText(text)
      }
      const label = nativeChatPastedTextLabel()
      const chipId = chips.begin(undefined, label)
      if (!chipId) {
        return true
      }
      void savePastedTextFile(owner, text).then(
        (saved) => {
          if (!saved.ok) {
            if (chips.drop(chipId)) {
              setNotice(saved.notice)
            }
          } else if (!nativeChatAttachmentOwnerUnchanged(owner, resolveAttachmentOwner())) {
            chips.drop(chipId)
            setNotice(nativeChatAttachmentOwnerChangedNotice())
          } else {
            // Into the scope's draft even if the composer went away meanwhile, as an image paste.
            chips.attachReferences([{ id: chipId, path: saved.path }])
          }
        },
        (error) => {
          if (chips.drop(chipId)) {
            setNotice(nativeChatAttachFailedNotice([label], extractIpcErrorMessage(error, '')))
          }
        }
      )
      return true
    },
    [chips, draft, insertTypedText, resolveAttachmentOwner, setNotice]
  )
}
