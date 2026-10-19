import {
  SET_TERMINAL_PANE_TITLE_EVENT,
  type SetTerminalPaneTitleDetail
} from '@/constants/terminal'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import { findTerminalTabWorktreeId } from '@/components/native-chat/native-chat-file-link'
import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import { useAppStore } from '../../store'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

function showRuntimePaneTitle(tabId: string, leafId: string, title: string | null): void {
  const store = useAppStore.getState()
  const layout = store.terminalLayoutsByTabId[tabId]
  if (!layout) {
    return
  }
  // Parked panes have no event listener; their next mount reads this same layout.
  const titlesByLeafId = { ...layout.titlesByLeafId }
  if (title) {
    titlesByLeafId[leafId] = title
  } else {
    delete titlesByLeafId[leafId]
  }
  const { titlesByLeafId: _previousTitles, ...layoutWithoutTitles } = layout
  const nextLayout: TerminalLayoutSnapshot =
    Object.keys(titlesByLeafId).length > 0
      ? { ...layoutWithoutTitles, titlesByLeafId }
      : layoutWithoutTitles
  store.setTabLayout(tabId, nextLayout)
  const detail: SetTerminalPaneTitleDetail = { tabId, leafId, title }
  window.dispatchEvent(new CustomEvent(SET_TERMINAL_PANE_TITLE_EVENT, { detail }))
}

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
  const show = (): void => showRuntimePaneTitle(tabId, leafId, normalizedTitle)
  const worktreeId = findTerminalTabWorktreeId(store.tabsByWorktree, tabId)
  // Switch point: a main-owned layout takes the rename first, as the GUI's rename does.
  if (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    worktreeId &&
    sendLayoutCommandToOwner(
      worktreeId,
      { type: 'renamePane', tabId, leafId, title: normalizedTitle },
      { apply: show, asToday: show }
    )
  ) {
    return
  }
  show()
}
