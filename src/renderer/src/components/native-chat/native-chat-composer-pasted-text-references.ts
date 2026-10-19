import { translate } from '@/i18n/i18n'
import { formatNativeChatFileReference } from '../../../../shared/agent-image-paste'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { notifyScope } from './native-chat-composer-draft-memory'
import {
  NATIVE_CHAT_PASTED_TEXT_TOKEN,
  nativeChatPastedTextOperations as operations,
  nativeChatPastedTextId,
  nativeChatPastedTextToken,
  nativeChatPasteNotSavedNotice
} from './native-chat-pasted-text-reference'

export function nativeChatPastedTextState(scope: string, token: string): string | null {
  const id = nativeChatPastedTextId(token)
  if (!id) {
    return null
  }
  return (
    readNativeChatComposerDraft(scope).pastedTextFiles?.[id] ??
    (operations.get(id)?.scopeKey === scope ? 'saving' : 'unsaved')
  )
}

export function resolveNativeChatPastedText(scope: string, text: string): string {
  return text
    .split(NATIVE_CHAT_PASTED_TEXT_TOKEN)
    .map((part, index) => {
      const state = index % 2 === 1 ? nativeChatPastedTextState(scope, part) : null
      return state && state !== 'saving' && state !== 'unsaved'
        ? formatNativeChatFileReference(state)
        : part
    })
    .join('')
}

/** Both the actual candidate and its original scope must be free of unavailable identities. */
export function nativeChatPastedTextAdmission(
  scope: string,
  candidate = ''
): 'saving' | 'unsaved' | null {
  const states = [readNativeChatComposerDraft(scope).text, candidate]
    .join('\n')
    .split(NATIVE_CHAT_PASTED_TEXT_TOKEN)
    .filter((_, index) => index % 2 === 1)
    .map((token) => nativeChatPastedTextState(scope, token))
  return states.includes('saving') ? 'saving' : states.includes('unsaved') ? 'unsaved' : null
}

export function admitNativeChatPastedText(
  scope: string,
  candidate: string,
  onError: (notice: string) => void
): boolean {
  const state = nativeChatPastedTextAdmission(scope, candidate)
  if (state === 'unsaved') {
    onError(nativeChatPasteNotSavedNotice())
  }
  return state === null
}

/** Success records one durable fact; every failure ends I/O without editing the draft. */
export function settleNativeChatPastedText(id: string, path?: string): boolean {
  const operation = operations.get(id)
  if (!operation) {
    return false
  }
  operations.delete(id)
  const { scopeKey } = operation
  const draft = readNativeChatComposerDraft(scopeKey)
  const present = draft.text.includes(nativeChatPastedTextToken(id))
  if (present && path) {
    updateNativeChatComposerDraft(
      scopeKey,
      { pastedTextFiles: { ...draft.pastedTextFiles, [id]: path } },
      'immediate'
    )
  } else {
    notifyScope(scopeKey)
  }
  return present
}

export function nativeChatPastedTextClipboardText(scope: string, token: string): string {
  const state = nativeChatPastedTextState(scope, token)
  if (state === null) {
    return token
  }
  if (state === 'saving') {
    return operations.get(nativeChatPastedTextId(token) ?? '')?.text ?? ''
  }
  return state === 'unsaved'
    ? translate('components.native-chat.composer.pasteNotSavedLabel', 'Paste not saved')
    : formatNativeChatFileReference(state)
}
