import type { TerminalPanePlacement } from '../../shared/terminal-pane-placement'
import type { TerminalPaneSplitDirection } from '../../shared/terminal-tab-types'

/**
 * A runtime-started tab opens in the group asked for, else the first group (as the live view). Its
 * title is the user's name for it, as when the window opens a titled terminal.
 */
export function newTabIn(opts: {
  viewMode?: 'terminal' | 'chat'
  targetGroupId?: string
  title?: string
}): {
  placement: TerminalPanePlacement
  groupId?: string
} {
  const { viewMode, targetGroupId, title } = opts
  const row = {
    ...(viewMode ? { viewMode } : {}),
    ...(title ? { customTitle: title } : {})
  }
  return {
    placement: Object.keys(row).length > 0 ? { kind: 'new-tab', row } : { kind: 'new-tab' },
    ...(targetGroupId ? { groupId: targetGroupId } : {})
  }
}

export function runtimeSplitPlacement(
  parentLeafId: string,
  direction: TerminalPaneSplitDirection
): TerminalPanePlacement {
  return { kind: 'split', parentLeafId, direction }
}
