import { translate } from '@/i18n/i18n'

export const NATIVE_CHAT_PASTE_REQUEST_EVENT = 'orca-native-chat-paste-request'
export const NATIVE_CHAT_ROOT_SELECTOR = '[data-native-chat-root="true"]'

export type TextPaste = (text: string) => void

/** Asks a mounted chat input owner to paste; left unclaimed when no input can take it. */
export class NativeChatPasteRequest extends Event {
  constructor(readonly onTextOnlyPaste?: TextPaste) {
    super(NATIVE_CHAT_PASTE_REQUEST_EVENT, { cancelable: true })
  }
}

export function nativeChatPasteUnavailableNotice(): string {
  return translate(
    'components.native-chat.composer.pasteUnavailable',
    "Can't paste — this chat isn't accepting input right now."
  )
}
