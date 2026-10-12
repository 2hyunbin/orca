import type { TerminalPanePlacement } from '../../shared/terminal-pane-placement'
import type { TerminalPaneSplitDirection } from '../../shared/terminal-tab-types'

/** A main-side create always opens its own tab. */
export function runtimeNewTabPlacement(viewMode?: 'terminal' | 'chat'): TerminalPanePlacement {
  return viewMode ? { kind: 'new-tab', row: { viewMode } } : { kind: 'new-tab' }
}

/** A runtime-started tab opens in the group asked for, else the first group (as the live view). */
export function newTabIn(opts: {
  viewMode?: 'terminal' | 'chat'
  targetGroupId?: string
  afterTabId?: string
}): {
  placement: TerminalPanePlacement
  groupId?: string
  afterTabId?: string
} {
  const { targetGroupId, afterTabId } = opts
  return {
    placement: runtimeNewTabPlacement(opts.viewMode),
    ...(targetGroupId ? { groupId: targetGroupId } : {}),
    ...(afterTabId ? { afterTabId } : {})
  }
}

export function runtimeSplitPlacement(
  parentLeafId: string,
  direction: TerminalPaneSplitDirection
): TerminalPanePlacement {
  return { kind: 'split', parentLeafId, direction }
}
