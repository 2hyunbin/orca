// Pure helpers for reconciling incoming session-tab snapshots on mobile. Kept
// free of react-native imports so they stay unit-testable in the node test env.
// Two races motivate these: out-of-order snapshots (subscription vs poll vs
// post-mutation refetch) and the brief window after a local close before the
// publisher's snapshot reflects it.

import type { SessionTabCloseLedger } from '../../../src/shared/session-tab-close-ledger'
import type { MobileSessionTab } from './mobile-session-route-types'

/** The last snapshot applied from a publisher, used to reject older ones. */
export type AppliedSnapshotMarker = { epoch: string | null; version: number }

/**
 * Whether an incoming snapshot should be applied. Rejects only snapshots
 * STRICTLY older than the last applied one from the same publisher (epoch) so an
 * out-of-order response can't revive a tab a newer snapshot dropped. Equal
 * versions are accepted (and reprocessed) — polling returns the same cached
 * version repeatedly, and reprocessing is what lets pending tab closes expire and
 * clear; rejecting equal versions would strand them. A different epoch is a new
 * publisher (renderer reload / headless), accepted as the new floor. Mutates
 * `marker` to record the accepted snapshot.
 */
export function acceptSessionSnapshot(
  incoming: { publicationEpoch?: string; snapshotVersion: number },
  marker: AppliedSnapshotMarker
): boolean {
  const incomingEpoch = incoming.publicationEpoch ?? null
  if (incomingEpoch === marker.epoch) {
    if (incoming.snapshotVersion < marker.version) {
      return false
    }
  } else {
    marker.epoch = incomingEpoch
  }
  marker.version = incoming.snapshotVersion
  return true
}

export function confirmsMirroredTabSelection(publicationEpoch?: string): boolean {
  // Why: phone-local persistence acknowledges the mutation, not host focus;
  // keep the pending guard until any host publication confirms the selection.
  return !publicationEpoch?.startsWith('mobile-local:')
}

/** The host tab a listed tab belongs to: a terminal pane belongs to its parent tab. */
function topLevelTabId(tab: MobileSessionTab): string {
  return tab.type === 'terminal' ? (tab.parentTabId ?? tab.id) : tab.id
}

/** Records a close the host accepted, so lists it publishes before removing the tab stay without it. */
export function recordAcceptedTabClose(
  ledger: SessionTabCloseLedger,
  worktreeId: string,
  tabId: string,
  now: number
): void {
  const ticket = ledger.begin(worktreeId, tabId, now)
  if (ticket) {
    ledger.settle(ticket, 'closed', now)
  }
}

/**
 * Drops tabs whose accepted close the host has not published yet. A whole-tab close hides all its
 * panes, a pane close only that pane; a list that omits the closed id ends its entry.
 */
export function hidePendingTabCloses(
  ledger: SessionTabCloseLedger,
  worktreeId: string,
  tabs: MobileSessionTab[],
  now: number
): MobileSessionTab[] {
  const visible = ledger.filter(worktreeId, tabs, topLevelTabId, now)
  return visible === tabs ? tabs : [...visible]
}
