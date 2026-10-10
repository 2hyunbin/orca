import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-session-contracts'
import type { TerminalPanePlacement } from '../../shared/terminal-pane-placement'
import type { TerminalPaneSplitDirection } from '../../shared/terminal-tab-types'

/** A main-side create always opens its own tab. */
export function runtimeNewTabPlacement(viewMode?: 'terminal' | 'chat'): TerminalPanePlacement {
  return viewMode ? { kind: 'new-tab', row: { viewMode } } : { kind: 'new-tab' }
}

/** A runtime-started tab opens in the group asked for, else the group focused on the host. */
export function newTabIn(
  opts: { viewMode?: 'terminal' | 'chat'; targetGroupId?: string },
  snapshots: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>,
  worktreeId: string
): { placement: TerminalPanePlacement; groupId?: string } {
  const groupId = opts.targetGroupId ?? snapshots.get(worktreeId)?.activeGroupId
  return { placement: runtimeNewTabPlacement(opts.viewMode), ...(groupId ? { groupId } : {}) }
}

export function runtimeSplitPlacement(
  parentLeafId: string,
  direction: TerminalPaneSplitDirection
): TerminalPanePlacement {
  return { kind: 'split', parentLeafId, direction }
}
