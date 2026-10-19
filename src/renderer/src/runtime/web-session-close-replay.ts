// Why: a user's close of a paired host's tab prunes the local mirror at once, so a close the host
// never received (the connection dropped) would otherwise be lost and the host's next snapshot
// brings the tab back. The close is held in the persisted store and sent again once the host is
// reachable, so a reload does not forget it either.

import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  PAIRED_TERMINAL_TAB_CLOSE_INTENT_MAX_AGE_MS,
  pairedTerminalTabCloseIntentKey,
  type PairedTerminalTabCloseIntent
} from '../../../shared/paired-terminal-tab-close-intent'
import type { PairedTerminalTabCloseIntentsByEnvironment } from './paired-terminal-tab-close-intents'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import {
  clearWebSessionCloseIntent,
  makeWebSessionCloseIntentDurable,
  recordWebSessionCloseIntent
} from './web-session-close-intent'
import type { WebSessionIntentOwner } from './web-session-intent-owner'

/** Bounded so a host that keeps failing the close hands the tab back instead of hiding it forever. */
export const MAX_WEB_SESSION_CLOSE_REPLAY_ATTEMPTS = 3

/** Passed rather than imported: the store reaches this module, so importing it back closes a cycle. */
export type PairedTerminalTabCloseIntentStore = {
  getIntents: () => PairedTerminalTabCloseIntentsByEnvironment | undefined
  record: (environmentId: string, intent: PairedTerminalTabCloseIntent) => void
  clear: (environmentId: string, intentKeys: readonly string[]) => void
}

export type WebSessionCloseReplay = {
  owner: WebSessionIntentOwner
  worktreeId: string
  /** Every host id the close suppressed; the first is the one sent. */
  hostTabIds: readonly string[]
  intentKey: string
}

// Session-scoped on purpose: after a reload a held close starts a fresh attempt count.
const attemptsByIntent = new Map<string, { attempts: number; inFlight: boolean }>()

function attemptKey(environmentId: string, intentKey: string): string {
  return `${environmentId}\0${intentKey}`
}

function listHeldIntents(
  store: PairedTerminalTabCloseIntentStore,
  environmentId: string
): readonly PairedTerminalTabCloseIntent[] {
  return store.getIntents()?.[environmentId] ?? []
}

function intentOwner(
  environmentId: string,
  intent: PairedTerminalTabCloseIntent
): WebSessionIntentOwner {
  return intent.pairingRevision !== undefined
    ? { environmentId, pairingRevision: intent.pairingRevision }
    : { environmentId }
}

function hideHeldClose(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabIds: readonly string[]
) {
  for (const hostTabId of hostTabIds) {
    recordWebSessionCloseIntent(owner, worktreeId, hostTabId, Date.now())
    makeWebSessionCloseIntentDurable(owner, worktreeId, hostTabId)
  }
}

function revealHeldClose(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabIds: readonly string[]
) {
  for (const hostTabId of hostTabIds) {
    clearWebSessionCloseIntent(owner, worktreeId, hostTabId)
  }
}

/** Keeps an unsent user close, hiding its tab; a repeat for the same tab keeps its attempt count. */
export function holdWebSessionCloseForReplay(
  store: PairedTerminalTabCloseIntentStore,
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabIds: readonly string[]
): void {
  hideHeldClose(owner, worktreeId, hostTabIds)
  if (!worktreeId || !hostTabIds[0]) {
    return
  }
  const { environmentId } = owner
  const before = listHeldIntents(store, environmentId)
  store.record(environmentId, {
    hostTabIds: [...hostTabIds],
    worktreeId,
    closedAt: Date.now(),
    ...(owner.pairingRevision !== undefined ? { pairingRevision: owner.pairingRevision } : {})
  })
  const kept = new Set(listHeldIntents(store, environmentId).map(pairedTerminalTabCloseIntentKey))
  for (const intent of before) {
    const key = pairedTerminalTabCloseIntentKey(intent)
    if (!kept.has(key)) {
      // An evicted close is never sent again, so it must stop hiding its tab.
      attemptsByIntent.delete(attemptKey(environmentId, key))
      revealHeldClose(intentOwner(environmentId, intent), intent.worktreeId, intent.hostTabIds)
    }
  }
}

/**
 * Re-hides every held close whose tab this snapshot lists and returns the ones it makes due: a
 * snapshot that still lists the tab proves the host is reachable and still holds it. Absence is
 * not treated as removal, because an incomplete inventory omits tabs too; a close whose tab never
 * returns ends at delivery, give-up, the cap, or the age bound.
 */
export function takeDueWebSessionCloseReplays(
  store: PairedTerminalTabCloseIntentStore,
  environmentId: string,
  worktreeId: string,
  presentHostTabIds: ReadonlySet<string>
): WebSessionCloseReplay[] {
  const now = Date.now()
  const currentRevision = getRuntimeEnvironmentRevision(environmentId)
  const dropped: string[] = []
  const due: WebSessionCloseReplay[] = []
  for (const intent of listHeldIntents(store, environmentId)) {
    if (
      intent.worktreeId !== worktreeId ||
      !intent.hostTabIds.some((hostTabId) => presentHostTabIds.has(hostTabId))
    ) {
      continue
    }
    const intentKey = pairedTerminalTabCloseIntentKey(intent)
    const key = attemptKey(environmentId, intentKey)
    // Why: the close was the old pairing's, so a replacement host must never receive it; and past
    // the age bound the tab is one this client can no longer explain hiding.
    if (
      intent.pairingRevision !== currentRevision ||
      now - intent.closedAt > PAIRED_TERMINAL_TAB_CLOSE_INTENT_MAX_AGE_MS
    ) {
      dropped.push(intentKey)
      attemptsByIntent.delete(key)
      continue
    }
    const owner = intentOwner(environmentId, intent)
    // Why every held close, in flight too: a reload or a subscription reinstall clears close
    // intents, and this snapshot lists the tab.
    hideHeldClose(owner, intent.worktreeId, intent.hostTabIds)
    const attempt = attemptsByIntent.get(key) ?? { attempts: 0, inFlight: false }
    if (attempt.inFlight) {
      continue
    }
    attempt.inFlight = true
    attempt.attempts += 1
    attemptsByIntent.set(key, attempt)
    due.push({ owner, worktreeId: intent.worktreeId, hostTabIds: intent.hostTabIds, intentKey })
  }
  if (dropped.length > 0) {
    store.clear(environmentId, dropped)
  }
  return due
}

/** 'gave-up' means the caller must stop hiding the tab: the host kept refusing the close. */
export function settleWebSessionCloseReplay(
  store: PairedTerminalTabCloseIntentStore,
  replay: WebSessionCloseReplay,
  delivered: boolean
): 'done' | 'retry' | 'gave-up' {
  const { environmentId } = replay.owner
  const key = attemptKey(environmentId, replay.intentKey)
  const attempt = attemptsByIntent.get(key)
  const held = listHeldIntents(store, environmentId).some(
    (intent) => pairedTerminalTabCloseIntentKey(intent) === replay.intentKey
  )
  if (!attempt || !held) {
    attemptsByIntent.delete(key)
    return 'done'
  }
  attempt.inFlight = false
  if (delivered || attempt.attempts >= MAX_WEB_SESSION_CLOSE_REPLAY_ATTEMPTS) {
    attemptsByIntent.delete(key)
    store.clear(environmentId, [replay.intentKey])
    return delivered ? 'done' : 'gave-up'
  }
  return 'retry'
}

/** Sends the closes a received host snapshot made due; see `takeDueWebSessionCloseReplays`. */
export function replayWebSessionClosesDueForSnapshot(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult | { worktree: string; removed: true },
  store: PairedTerminalTabCloseIntentStore
): void {
  if (!('tabs' in snapshot) || listHeldIntents(store, environmentId).length === 0) {
    return
  }
  const presentHostTabIds = new Set(
    snapshot.tabs.map((tab) => (tab.type === 'terminal' ? tab.parentTabId : tab.id))
  )
  const due = takeDueWebSessionCloseReplays(
    store,
    environmentId,
    snapshot.worktree,
    presentHostTabIds
  )
  if (due.length === 0) {
    return
  }
  // Lazy: the lifecycle module reaches the store, which loads this module.
  void import('./web-runtime-session-tab-lifecycle').then(({ replayWebSessionTabCloses }) =>
    replayWebSessionTabCloses(environmentId, due)
  )
}

export function resetWebSessionCloseReplaysForTests(): void {
  attemptsByIntent.clear()
}
