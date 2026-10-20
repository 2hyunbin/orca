// Layout-owner build: a paired desktop's Reopen of panes main holds for a newer build's terminal
// service. Main stops the newer service as the desktop's own Reopen does, then starts each pane
// still held; the result shows in main's frames, so the desktop applies nothing itself.

import type { NewerDaemonReopenResult } from '../../../../shared/newer-daemon-hold'
import type { RestoredPane } from './restored-pane-start'

export type HeldPaneReopenPorts = {
  /** Main's published status for the pane (`tabId:leafId`) is 'held'. */
  isHeld: (paneKey: string) => boolean
  /** Stops every newer terminal service this build holds for; false while one may still run. */
  stopNewerDaemons: () => Promise<boolean>
  /** The pane's one start; null when main no longer holds the pane. */
  start: (pane: RestoredPane) => Promise<string | null>
}

/** Reopened only when every pane the desktop named that main still holds now has its terminal. */
export async function reopenHeldPanes(
  panes: readonly RestoredPane[],
  ports: HeldPaneReopenPorts
): Promise<NewerDaemonReopenResult> {
  const held = new Map<string, RestoredPane>()
  for (const pane of panes) {
    const key = `${pane.tabId}:${pane.leafId}`
    if (ports.isHeld(key)) {
      held.set(key, pane)
    }
  }
  // Why: stopping a newer build's service ends its terminals; only a hold to release warrants it.
  if (held.size === 0) {
    return { reopened: true }
  }
  if (!(await ports.stopNewerDaemons())) {
    return { reopened: false }
  }
  const started = await Promise.allSettled([...held.values()].map((pane) => ports.start(pane)))
  return {
    reopened: started.every((result) => result.status === 'fulfilled' && result.value !== null)
  }
}
