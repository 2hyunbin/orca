// Why: a user's close of a paired host's tab prunes the local mirror at once, so a close the host
// never received (the connection dropped) would otherwise be lost and the host's next snapshot
// brings the tab back. The close is kept here and sent again once the host is reachable.

import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  clearWebSessionCloseIntent,
  makeWebSessionCloseIntentDurable,
  recordWebSessionCloseIntent
} from './web-session-close-intent'
import { webSessionIntentOwnerKey, type WebSessionIntentOwner } from './web-session-intent-owner'

/** Bounded so a host that keeps failing the close hands the tab back instead of hiding it forever. */
export const MAX_WEB_SESSION_CLOSE_REPLAY_ATTEMPTS = 3
export const MAX_PENDING_WEB_SESSION_CLOSE_REPLAYS = 256

export type WebSessionCloseReplay = {
  owner: WebSessionIntentOwner
  worktreeId: string
  /** Every host id the close suppressed; the first is the one sent. */
  hostTabIds: readonly string[]
  attempts: number
  inFlight: boolean
}

const pendingReplays = new Map<string, WebSessionCloseReplay>()

function replayPartitionPrefix(owner: WebSessionIntentOwner, worktreeId: string): string {
  return `${webSessionIntentOwnerKey(owner)}\0${worktreeId}\0`
}

function replayKey(owner: WebSessionIntentOwner, worktreeId: string, hostTabId: string): string {
  return `${replayPartitionPrefix(owner, worktreeId)}${hostTabId}`
}

/** Keeps an unsent user close; a repeat for the same tab keeps its attempt count. */
export function queueWebSessionCloseReplay(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabIds: readonly string[]
): void {
  const [primary] = hostTabIds
  if (!worktreeId || !primary) {
    return
  }
  const key = replayKey(owner, worktreeId, primary)
  if (pendingReplays.has(key)) {
    return
  }
  while (pendingReplays.size >= MAX_PENDING_WEB_SESSION_CLOSE_REPLAYS) {
    const oldest = pendingReplays.entries().next()
    if (oldest.done) {
      break
    }
    const [oldestKey, evicted] = oldest.value
    pendingReplays.delete(oldestKey)
    // An evicted close is never sent again, so it must stop hiding its tab.
    for (const hostTabId of evicted.hostTabIds) {
      clearWebSessionCloseIntent(evicted.owner, evicted.worktreeId, hostTabId)
    }
  }
  pendingReplays.set(key, { owner, worktreeId, hostTabIds, attempts: 0, inFlight: false })
}

/**
 * The replays a host snapshot makes due: one that still lists the tab proves the host is reachable
 * and still holds it. A replay whose tab the snapshot no longer lists is done -- the host removed it.
 */
export function takeDueWebSessionCloseReplays(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  presentHostTabIds: ReadonlySet<string>
): WebSessionCloseReplay[] {
  const prefix = replayPartitionPrefix(owner, worktreeId)
  const due: WebSessionCloseReplay[] = []
  for (const [key, replay] of pendingReplays) {
    if (!key.startsWith(prefix)) {
      continue
    }
    if (!replay.hostTabIds.some((hostTabId) => presentHostTabIds.has(hostTabId))) {
      pendingReplays.delete(key)
      continue
    }
    if (!replay.inFlight) {
      replay.inFlight = true
      replay.attempts += 1
      due.push(replay)
    }
  }
  return due
}

/** 'gave-up' means the caller must stop hiding the tab: the host kept refusing the close. */
export function settleWebSessionCloseReplay(
  replay: WebSessionCloseReplay,
  delivered: boolean
): 'done' | 'retry' | 'gave-up' {
  const key = replayKey(replay.owner, replay.worktreeId, replay.hostTabIds[0])
  if (pendingReplays.get(key) !== replay) {
    return 'done'
  }
  if (delivered) {
    pendingReplays.delete(key)
    return 'done'
  }
  replay.inFlight = false
  if (replay.attempts >= MAX_WEB_SESSION_CLOSE_REPLAY_ATTEMPTS) {
    pendingReplays.delete(key)
    return 'gave-up'
  }
  return 'retry'
}

/** Sends the closes a received host snapshot made due; see `takeDueWebSessionCloseReplays`. */
export function replayWebSessionClosesDueForSnapshot(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult | { worktree: string; removed: true }
): void {
  if (pendingReplays.size === 0 || !('tabs' in snapshot)) {
    return
  }
  const presentHostTabIds = new Set(
    snapshot.tabs.map((tab) => (tab.type === 'terminal' ? tab.parentTabId : tab.id))
  )
  const due = takeDueWebSessionCloseReplays({ environmentId }, snapshot.worktree, presentHostTabIds)
  if (due.length === 0) {
    return
  }
  // Why re-assert: a subscription reinstall clears close intents, and this snapshot lists the tab.
  for (const replay of due) {
    for (const hostTabId of replay.hostTabIds) {
      recordWebSessionCloseIntent(replay.owner, replay.worktreeId, hostTabId, Date.now())
      makeWebSessionCloseIntentDurable(replay.owner, replay.worktreeId, hostTabId)
    }
  }
  // Lazy: the lifecycle module reaches the store, which loads this module.
  void import('./web-runtime-session-tab-lifecycle').then(({ replayWebSessionTabCloses }) =>
    replayWebSessionTabCloses(environmentId, due)
  )
}

export function resetWebSessionCloseReplaysForTests(): void {
  pendingReplays.clear()
}
