import { translate } from '@/i18n/i18n'
import { OS_FILE_DROP_OWNER_ATTRIBUTE } from '../../../shared/native-file-drop-preparation'

export const NATIVE_CHAT_PASTE_REQUEST_EVENT = 'orca-native-chat-paste-request'
export const NATIVE_CHAT_ROOT_SELECTOR = '[data-native-chat-root="true"]'

export type TextPaste = (text: string) => void

export function findNativeChatPasteOwner(target: EventTarget | null): Element | null {
  const card = target instanceof Element ? target.closest('[data-queued-message-editor]') : null
  return card?.hasAttribute(OS_FILE_DROP_OWNER_ATTRIBUTE) ? card : null
}

/** Asks a mounted chat input owner to paste; left unclaimed when no input can take it. */
export class NativeChatPasteRequest extends Event {
  constructor(
    readonly onTextOnlyPaste?: TextPaste,
    readonly clipboardEvent?: ClipboardEvent
  ) {
    super(NATIVE_CHAT_PASTE_REQUEST_EVENT, { cancelable: true })
  }
}

export function nativeChatPasteUnavailableNotice(): string {
  return translate(
    'components.native-chat.composer.pasteUnavailable',
    "Can't paste — this chat isn't accepting input right now."
  )
}
