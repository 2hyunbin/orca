import {
  SET_TERMINAL_PANE_TITLE_EVENT,
  type SetTerminalPaneTitleDetail
} from '@/constants/terminal'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import { useAppStore } from '../../store'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'

/** Applies main's title for one pane; the tab's own name is never touched. */
export function applyRuntimePaneTitle({ tabId, leafId, title }: SetTerminalPaneTitleDetail): void {
  const store = useAppStore.getState()
  const layout = store.terminalLayoutsByTabId[tabId]
  if (
    !layout ||
    !isTerminalLeafId(leafId) ||
    !collectLeafIdsInOrder(layout.root).includes(leafId)
  ) {
    return
  }
  const normalizedTitle = title?.trim() || null
  if ((layout.titlesByLeafId?.[leafId] ?? null) === normalizedTitle) {
    return
  }
  // Parked panes have no event listener; their next mount reads this same layout.
  const titlesByLeafId = { ...layout.titlesByLeafId }
  if (normalizedTitle) {
    titlesByLeafId[leafId] = normalizedTitle
  } else {
    delete titlesByLeafId[leafId]
  }
  const { titlesByLeafId: _previousTitles, ...layoutWithoutTitles } = layout
  const nextLayout: TerminalLayoutSnapshot =
    Object.keys(titlesByLeafId).length > 0
      ? { ...layoutWithoutTitles, titlesByLeafId }
      : layoutWithoutTitles
  store.setTabLayout(tabId, nextLayout)
  const detail: SetTerminalPaneTitleDetail = { tabId, leafId, title: normalizedTitle }
  window.dispatchEvent(new CustomEvent(SET_TERMINAL_PANE_TITLE_EVENT, { detail }))
}
