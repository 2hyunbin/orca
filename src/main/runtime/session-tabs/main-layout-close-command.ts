// Layout-owner builds: an explicit close of a pane main owns is one layout command, closeTabs for a
// tab or its last pane and closePane otherwise; the CLI's and a phone's close share it. Main's
// close stops nothing itself, so the terminals it ends stop here.

import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WindowLayoutCommand } from '../runtime-layout-apply'
import { NO_STOP, type ExplicitCloseStop } from './explicit-terminal-close-pty-stops'

export type MainLayoutCloseHost = {
  /** Every pane of a tab main owns, in pane order. */
  panesOfTab: (tabId: string) => { leafId: string; ptyId: string | null }[]
  applyLayoutCommand: (command: WindowLayoutCommand) => Promise<LayoutApplyReply>
  stop: (ptyIds: string[], addressedPtyId: string) => Promise<ExplicitCloseStop>
}

export type MainLayoutCloseTarget = {
  worktreeId: string
  tabId: string
  leafId: string
  /** The whole tab, not just the pane; a tab's last pane closes its tab either way. */
  wholeTab: boolean
  /** A confirmed close (a phone's force): a pinned tab closes too. */
  force?: boolean
  /** The terminal the close addresses; absent, the pane's bound terminal. */
  addressedPtyId?: string | null
  /** False when the caller stops the terminals itself, or a lifecycle echo must not stop them. */
  stopEnded: boolean
}

export type MainLayoutClose = {
  /** 'gone': a concurrent close already took the tab or pane, so this one changed nothing. */
  outcome: 'closed' | 'gone'
  closesTab: boolean
  /** How the addressed terminal's stop ended; NO_STOP with no addressed terminal. */
  addressedStop: ExplicitCloseStop
}

/**
 * Closes the pane, or its tab, in main's layout. Null when main's layout holds no such pane. A
 * pinned tab refuses (`terminal_tab_pinned`) unless forced; any other refusal throws its code.
 */
export async function closeInMainLayout(
  host: MainLayoutCloseHost,
  target: MainLayoutCloseTarget
): Promise<MainLayoutClose | null> {
  const panes = host.panesOfTab(target.tabId)
  const pane = panes.find((entry) => entry.leafId === target.leafId)
  if (!pane) {
    return null
  }
  const closesTab = target.wholeTab || panes.length <= 1
  const reply = await host.applyLayoutCommand(
    closesTab
      ? {
          type: 'closeTabs',
          workspace: target.worktreeId,
          tabIds: [target.tabId],
          // Unforced closes keep a pinned tab, as the window-era closes refused it.
          refusePinned: !target.force,
          recordClose: 'user'
        }
      : {
          type: 'closePane',
          workspace: target.worktreeId,
          tabId: target.tabId,
          leafId: target.leafId
        }
  )
  if (!reply.ok) {
    if (reply.code === 'tab_not_found' || reply.code === 'pane_not_found') {
      return { outcome: 'gone', closesTab, addressedStop: NO_STOP }
    }
    // A refusal changed nothing: a deliberate freeze, say.
    throw new Error(reply.code)
  }
  if (reply.result.refused?.some((entry) => entry.code === 'tab_pinned')) {
    throw new Error('terminal_tab_pinned')
  }
  const addressedPtyId = target.addressedPtyId === undefined ? pane.ptyId : target.addressedPtyId
  const ended = closesTab
    ? panes.flatMap((entry) => (entry.ptyId ? [entry.ptyId] : []))
    : addressedPtyId
      ? [addressedPtyId]
      : []
  // Every terminal the close ends stops here, addressed or not.
  const stopAddress = addressedPtyId ?? ended[0]
  const stop = target.stopEnded && stopAddress ? await host.stop(ended, stopAddress) : NO_STOP
  return { outcome: 'closed', closesTab, addressedStop: addressedPtyId ? stop : NO_STOP }
}
