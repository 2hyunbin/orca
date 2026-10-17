import type { Tab } from '../../../../shared/tab-types'
import { sendLayoutApply, type WindowLayoutCommand } from '@/runtime/layout-apply-send'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import { findRenamableUnifiedTab } from './renamable-unified-tab'

/** The change, for the tab-bar tab main knows it by. */
type TabChange = (
  tabBarTabId: string
) => Extract<WindowLayoutCommand, { type: 'renameTab' | 'setTabProps' }>

type TabOwnerState = WorktreeRuntimeOwnerState & { unifiedTabsByWorktree: Record<string, Tab[]> }

/**
 * A tab's own change (title, color, view, launch agent) in a layout-owner build: main changes its
 * copy first, then `local` shows the same change, also when main lacks the tab. False when main is
 * not asked (no such tab-bar tab, or a paired server owns the workspace): the caller runs `local`.
 */
export function sendTabChangeToLayoutOwner(
  state: TabOwnerState,
  tab: Pick<Tab, 'id' | 'worktreeId'> | undefined,
  change: TabChange,
  local: () => void
): boolean {
  if (!tab) {
    return false
  }
  return sendLayoutApply(state, tab.worktreeId, change(tab.id), { apply: local, asToday: local })
}

/** As `sendTabChangeToLayoutOwner`, for a tab addressed as its rename and color are: a terminal by its terminal's id. */
export function sendRenamableTabChangeToLayoutOwner(
  state: TabOwnerState,
  tabId: string,
  change: TabChange,
  local: () => void
): boolean {
  return sendTabChangeToLayoutOwner(
    state,
    findRenamableUnifiedTab(state.unifiedTabsByWorktree, tabId),
    change,
    local
  )
}

/**
 * Terminal tabs' changes in a layout-owner build, each to main first; `local` shows them all and
 * runs again harmlessly for each answer. It runs at once when no change reaches main.
 */
export function sendTerminalTabChangesToLayoutOwner(
  state: TabOwnerState,
  changes: readonly { tabId: string; change: TabChange }[],
  local: () => void
): void {
  let sent = false
  let unsent = false
  for (const { tabId, change } of changes) {
    if (sendRenamableTabChangeToLayoutOwner(state, tabId, change, local)) {
      sent = true
    } else {
      unsent = true
    }
  }
  if (unsent || !sent) {
    local()
  }
}
