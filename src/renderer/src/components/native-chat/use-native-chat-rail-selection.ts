// Picking a rail tick, and what every navigation begins with: aborting a history
// jump still paging, which would otherwise land later and pull the reader away from
// where they just went, and handing a clicked tick back to the scroll position.

import { useCallback } from 'react'
import type { NativeChatRailItem } from './native-chat-message-rail-items'
import { useNativeChatRailHistoryJump } from './use-native-chat-rail-history-jump'
import type { NativeChatMessageRailState } from './use-native-chat-message-rail'
import type { NativeChatOlderPageResult } from './native-chat-pagination'

export function useNativeChatRailSelection({
  rail,
  sessionKey,
  isVisible,
  loadEarlier,
  readerLeavesEnd,
  jumpToLoaded
}: {
  rail: Pick<NativeChatMessageRailState, 'items' | 'onNavigate'>
  sessionKey: string
  isVisible: boolean
  loadEarlier: () => Promise<NativeChatOlderPageResult>
  readerLeavesEnd: () => void
  jumpToLoaded: (item: NativeChatRailItem) => void
}): {
  beginNavigation: () => void
  selectRailItem: (item: NativeChatRailItem) => void
  /** The unloaded message a pick is paging history in for. */
  pendingId: string | null
} {
  const {
    start: startHistoryJump,
    abort: abortHistoryJump,
    pendingId
  } = useNativeChatRailHistoryJump({
    items: rail.items,
    sessionKey,
    isVisible,
    loadEarlier,
    jumpToLoaded
  })
  const { onNavigate } = rail
  const beginNavigation = useCallback(() => {
    abortHistoryJump()
    onNavigate()
  }, [abortHistoryJump, onNavigate])
  const selectRailItem = useCallback(
    (item: NativeChatRailItem) => {
      beginNavigation()
      readerLeavesEnd()
      if (item.slotIndex === null) {
        startHistoryJump(item)
        return
      }
      jumpToLoaded(item)
    },
    [beginNavigation, jumpToLoaded, readerLeavesEnd, startHistoryJump]
  )
  return { beginNavigation, selectRailItem, pendingId }
}
