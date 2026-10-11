import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import type { ClientSessionTabSelection } from './client-session-tab-selection'

export type StoredClientSessionTabSelection = {
  selection: ClientSessionTabSelection
  revision: number
  shouldPersist: boolean
  closedPaneIds: ReadonlySet<string>
}

/**
 * Hides panes closed on this host from the client until the host list stops listing them.
 * Why panes only: a closed tab leaves the host list when its close commits, but the window drops a
 * pane on an unacknowledged notice, so the list keeps the pane until the window republishes.
 */
export function projectWithoutClosedClientSessionPanes(
  snapshot: RuntimeMobileSessionTabsResult,
  closedPaneIds: ReadonlySet<string>
): {
  snapshot: RuntimeMobileSessionTabsResult
  retainedClosedPaneIds: ReadonlySet<string>
} {
  if (closedPaneIds.size === 0) {
    return { snapshot, retainedClosedPaneIds: closedPaneIds }
  }
  const retainedClosedPaneIds = new Set(
    snapshot.tabs.filter((tab) => closedPaneIds.has(tab.id)).map((tab) => tab.id)
  )
  if (retainedClosedPaneIds.size === 0) {
    return { snapshot, retainedClosedPaneIds }
  }
  return {
    snapshot: {
      ...snapshot,
      tabs: snapshot.tabs.filter((tab) => !retainedClosedPaneIds.has(tab.id))
    },
    retainedClosedPaneIds
  }
}

export function forgetClosedClientSessionSelection(
  selection: ClientSessionTabSelection,
  existingClosedPaneIds: ReadonlySet<string>,
  tabIds: readonly string[],
  paneIds: readonly string[]
): {
  selection: ClientSessionTabSelection
  closedPaneIds: ReadonlySet<string>
  selectionChanged: boolean
  closureChanged: boolean
} {
  const forgotten = new Set(tabIds)
  const closedPaneIds = new Set([...existingClosedPaneIds, ...paneIds])
  const activeTabId =
    selection.activeTabId && forgotten.has(selection.activeTabId) ? null : selection.activeTabId
  const activeTabIdByGroupId = Object.fromEntries(
    Object.entries(selection.activeTabIdByGroupId).filter(
      ([, selectedTabId]) => !forgotten.has(selectedTabId)
    )
  )
  return {
    selection: { ...selection, activeTabId, activeTabIdByGroupId },
    closedPaneIds,
    selectionChanged:
      activeTabId !== selection.activeTabId ||
      Object.keys(activeTabIdByGroupId).length !==
        Object.keys(selection.activeTabIdByGroupId).length,
    closureChanged: closedPaneIds.size !== existingClosedPaneIds.size
  }
}

export function forgetClosedClientSessionTabsByWorktree(
  statesByClient: ReadonlyMap<string, Map<string, StoredClientSessionTabSelection>>,
  worktreeId: string,
  tabIds: readonly string[],
  paneIds: readonly string[]
): boolean {
  let persistedSelectionChanged = false
  for (const statesByWorktree of statesByClient.values()) {
    const state = statesByWorktree.get(worktreeId)
    if (!state) {
      continue
    }
    const closed = forgetClosedClientSessionSelection(
      state.selection,
      state.closedPaneIds,
      tabIds,
      paneIds
    )
    if (!closed.selectionChanged && !closed.closureChanged) {
      continue
    }
    statesByWorktree.set(worktreeId, {
      selection: closed.selection,
      revision: state.revision + 1,
      shouldPersist: state.shouldPersist,
      closedPaneIds: closed.closedPaneIds
    })
    persistedSelectionChanged ||= state.shouldPersist && closed.selectionChanged
  }
  return persistedSelectionChanged
}
