import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'

// Panes this window moved to a new tab whose host move has not settled, keyed by target pane key.
const pendingTargets = new Map<string, number>()
// Moves the host committed whose snapshot this window has not seen yet; a reply can beat its snapshot.
const awaitingSnapshot = new Set<string>()
// In-flight moves a host snapshot already showed, so their reply needs no hold.
const shownWhileInFlight = new Set<string>()

/** Marks a pane this window drew in its new tab before the host moved it; returns the release. */
export function beginPendingHostPaneMove(targetTabId: string, leafId: string): () => void {
  const key = makePaneKey(targetTabId, leafId)
  pendingTargets.set(key, (pendingTargets.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const remaining = (pendingTargets.get(key) ?? 1) - 1
    if (remaining > 0) {
      pendingTargets.set(key, remaining)
    } else {
      pendingTargets.delete(key)
      shownWhileInFlight.delete(key)
    }
  }
}

/** Keeps a move the host committed pending until a host snapshot names the pane in its new tab. */
export function holdHostPaneMoveUntilSnapshot(targetTabId: string, leafId: string): void {
  const key = makePaneKey(targetTabId, leafId)
  if (!shownWhileInFlight.has(key)) {
    awaitingSnapshot.add(key)
  }
}

/** Ends the hold on every committed move this host snapshot shows in its new tab. */
export function confirmHostPaneMovesInSnapshot(snapshot: RuntimeMobileSessionTabsResult): void {
  if (awaitingSnapshot.size === 0 && pendingTargets.size === 0) {
    return
  }
  for (const row of snapshot.tabs) {
    if (row.type === 'terminal' && row.leafId) {
      const key = makePaneKey(toWebTerminalSurfaceTabId(row.parentTabId), row.leafId)
      awaitingSnapshot.delete(key)
      if (pendingTargets.has(key)) {
        shownWhileInFlight.add(key)
      }
    }
  }
}

/** Whether a host snapshot may still predate this window's move of the pane into this tab. */
export function isPendingHostPaneMoveTarget(tabId: string, leafId: string): boolean {
  const key = makePaneKey(tabId, leafId)
  return pendingTargets.has(key) || awaitingSnapshot.has(key)
}

export function clearPendingHostPaneMovesForTests(): void {
  pendingTargets.clear()
  awaitingSnapshot.clear()
  shownWhileInFlight.clear()
}
