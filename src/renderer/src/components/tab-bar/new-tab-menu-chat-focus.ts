import { requestNativeChatComposerFocus } from '@/components/native-chat/use-native-chat-composer-reveal-focus'

// The chat a + menu choice opened at once; one menu closes at a time, so one pending tab is enough.
let pendingChatTabId: string | null = null

export function queueChatFocusAtNewTabMenuClose(tabId: string): void {
  pendingChatTabId = tabId
}

/** The menu's focus trap is gone once it closes, so the chat's composer takes focus now, before
 *  the next key, rather than a frame later. False when the menu opened no chat. */
export function focusChatAtNewTabMenuClose(): boolean {
  const tabId = pendingChatTabId
  pendingChatTabId = null
  if (!tabId) {
    return false
  }
  requestNativeChatComposerFocus(tabId)
  return true
}
