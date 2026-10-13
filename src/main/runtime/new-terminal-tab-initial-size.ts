import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'

type TerminalSize = { cols: number; rows: number }

// Used only when the worktree has no measured pane, e.g. it was never opened in the window.
const UNMEASURED_TERMINAL_SIZE: TerminalSize = { cols: 120, rows: 40 }

/** A new tab opens in its worktree's active group, so the pane active there is its measured size;
 *  an agent started at a guessed size keeps output wrapped to it until the tab is opened. */
export function resolveNewTerminalTabSize(
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
  getSize: (ptyId: string) => TerminalSize | null
): TerminalSize {
  const activeTerminal = snapshot?.tabs.find((tab) => tab.type === 'terminal' && tab.isActive)
  const ptyId = activeTerminal?.type === 'terminal' ? activeTerminal.ptyId : null
  return (ptyId ? getSize(ptyId) : null) ?? UNMEASURED_TERMINAL_SIZE
}
