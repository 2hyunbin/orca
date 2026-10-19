// A long text paste into a structured chat attaches as a file the agent reads, as a dropped file
// does, so the message's size bound never meets a pasted log or diff.

import { useCallback } from 'react'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { measureUtf8ByteLength } from '../../../../shared/utf8-byte-limits'
import { structuredAgentSessionBlocksTooLarge } from '../../../../shared/rpc-contract/structured-agent-session-message-params'
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'
import { imageReferencesToPromptMarkers } from '../../../../shared/native-chat-image-transcript-markers'
import {
  nativeChatAttachFailedNotice,
  nativeChatAttachmentOwnerChangedNotice,
  prepareNativeChatSessionAttachmentUpload,
  type NativeChatAttachmentOwner
} from './native-chat-attachment-upload'
import { nativeChatAttachmentOwnerUnchanged } from './native-chat-resolved-path-ownership'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { readNativeChatComposerDraft } from './native-chat-composer-draft-store'
import { nativeChatImageRowIds } from './native-chat-composer-image-references'
import {
  beginNativeChatPastedText,
  settleNativeChatPastedText,
  type NativeChatPastedTextOutcome
} from './native-chat-composer-pasted-text-references'
import {
  nativeChatPastedTextLabel,
  nativeChatPastedTextToken
} from './native-chat-pasted-text-reference'

/** Pastes this large attach as a file, measured in characters or UTF-8 bytes. */
export const NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD = 32 * 1024

function pastedTextTooLargeNotice(): string {
  return translate(
    'components.native-chat.composer.pastedTextTooLarge',
    'This paste would put your message over the 256 KB limit for one message. Shorten it, then paste again.'
  )
}

/** Whether the scope's draft as `text` is over the bound, measured on the body Send builds. */
function nativeChatDraftTooLarge(scopeKey: string, text: string): boolean {
  const prompt = imageReferencesToPromptMarkers(text, nativeChatImageRowIds(scopeKey))
  const images = readNativeChatComposerDraft(scopeKey).images
  const body = structuredAgentSessionSendBody(
    prompt,
    images.map(({ path }) => ({ path, previewUri: '' }))
  )
  return structuredAgentSessionBlocksTooLarge(body.blocks)
}

type PastedTextFileOwner = Extract<NativeChatAttachmentOwner, { kind: 'local' | 'runtime-session' }>

async function savePastedTextFile(
  owner: PastedTextFileOwner,
  text: string
): Promise<{ path: string } | { notice: string; unsupported?: true }> {
  if (owner.kind === 'local') {
    return { path: await window.api.ui.savePastedTextAsFile({ text }) }
  }
  const prepared = await prepareNativeChatSessionAttachmentUpload(owner)
  if (!prepared.ok) {
    return prepared
  }
  const { environmentId, ...agentSessionAttachment } = prepared.target
  return {
    path: await window.api.ui.savePastedTextAsFile({
      text,
      runtimeEnvironmentId: environmentId,
      agentSessionAttachment
    })
  }
}

/**
 * Returns the composer's text insertion for a paste: a long paste into a structured chat whose host
 * takes files becomes a pending pill where it went, which lands as an `@path` reference. Elsewhere
 * text goes in as typed, unless it could never be sent.
 */
export function useNativeChatPastedTextFile(args: {
  scopeKey: string
  /** Null: not a structured chat. Else the editor while it shows this scope. */
  scopeEditor: (() => NativeChatComposerInput | null) | null
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
  insertTypedText: (text: string) => boolean
  setNotice: (notice: string | null, errorText?: string) => void
}): (text: string) => boolean {
  const { scopeKey, scopeEditor, resolveAttachmentOwner, insertTypedText, setNotice } = args
  return useCallback(
    (text: string): boolean => {
      const input = scopeEditor?.()
      if (!scopeEditor || !input?.stagePastedText || input.disabled) {
        return insertTypedText(text)
      }
      const { value, selectionStart, selectionEnd } = input
      const tooLarge = nativeChatDraftTooLarge(
        scopeKey,
        `${value.slice(0, selectionStart ?? 0)}${text}${value.slice(selectionEnd ?? 0)}`
      )
      const long =
        text.length >= NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD ||
        measureUtf8ByteLength(text, { stopAfterBytes: NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD - 1 })
          .exceededLimit
      const owner = resolveAttachmentOwner()
      if (!tooLarge && (!long || (owner.kind !== 'local' && owner.kind !== 'runtime-session'))) {
        return insertTypedText(text)
      }
      if (owner.kind !== 'local' && owner.kind !== 'runtime-session') {
        setNotice(pastedTextTooLargeNotice())
        return true
      }
      input.focus()
      const id = beginNativeChatPastedText(scopeKey, input.stagePastedText, text)
      const settle = (outcome: NativeChatPastedTextOutcome, notice?: string, cause?: string) =>
        settleNativeChatPastedText(
          id,
          scopeEditor,
          outcome,
          () => notice && setNotice(notice, cause)
        )
      void savePastedTextFile(owner, text).then(
        (saved) => {
          if ('path' in saved) {
            if (nativeChatAttachmentOwnerUnchanged(owner, resolveAttachmentOwner())) {
              settle(saved)
            } else {
              settle('restore', nativeChatAttachmentOwnerChangedNotice())
            }
            return
          }
          // A server that keeps no files takes the paste inline wherever it still fits.
          const inline = readNativeChatComposerDraft(scopeKey).text.replaceAll(
            nativeChatPastedTextToken(id),
            text
          )
          if (saved.unsupported && !nativeChatDraftTooLarge(scopeKey, inline)) {
            settle('inline')
          } else {
            settle('restore', saved.unsupported ? pastedTextTooLargeNotice() : saved.notice)
          }
        },
        (error) => {
          const cause = extractIpcErrorMessage(error, '')
          settle('restore', nativeChatAttachFailedNotice([nativeChatPastedTextLabel()], cause))
        }
      )
      return true
    },
    [insertTypedText, resolveAttachmentOwner, scopeEditor, scopeKey, setNotice]
  )
}
