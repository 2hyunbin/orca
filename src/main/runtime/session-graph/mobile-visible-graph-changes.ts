import type { RuntimeSyncedTab } from '../../../shared/runtime-types'
import type { RuntimeLeafRecord } from '../runtime-terminal-state-records'
import type { RuntimeGraphState } from './session-graph-state'

export function collectMobileVisibleGraphChangedWorktrees(
  state: RuntimeGraphState,
  previousTabs: Map<string, RuntimeSyncedTab>,
  previousLeaves: Map<string, RuntimeLeafRecord>
): Set<string> {
  const changed = new Set<string>()
  for (const [tabId, tab] of state.tabs) {
    const prev = previousTabs.get(tabId)
    if (!prev || prev.title !== tab.title) {
      changed.add(tab.worktreeId)
    }
  }
  for (const [tabId, tab] of previousTabs) {
    if (!state.tabs.has(tabId)) {
      changed.add(tab.worktreeId)
    }
  }
  for (const [leafKey, leaf] of state.leaves) {
    const prev = previousLeaves.get(leafKey)
    if (
      !prev ||
      prev.ptyId !== leaf.ptyId ||
      prev.connected !== leaf.connected ||
      prev.paneTitle !== leaf.paneTitle
    ) {
      changed.add(leaf.worktreeId)
    }
  }
  for (const [leafKey, leaf] of previousLeaves) {
    if (!state.leaves.has(leafKey)) {
      changed.add(leaf.worktreeId)
    }
  }
  return changed
}

export type CollectMobileVisibleGraphChangedWorktrees = (
  previousTabs: Parameters<typeof collectMobileVisibleGraphChangedWorktrees>[1],
  previousLeaves: Parameters<typeof collectMobileVisibleGraphChangedWorktrees>[2]
) => ReturnType<typeof collectMobileVisibleGraphChangedWorktrees>
