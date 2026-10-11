// Why: closing a host's tab prunes this window's copy at once, so host lists published before the
// host handled the close must not bring it back. One shared record serves every tab kind and host.

import {
  SessionTabCloseLedger,
  type SessionTabCloseOutcome,
  type SessionTabCloseTicket
} from '../../../shared/session-tab-close-ledger'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { webSessionIntentOwnerKey, type WebSessionIntentOwner } from './web-session-intent-owner'

const ledger = new SessionTabCloseLedger()
// The pairing each partition was recorded under, so an ended pairing's closes can be found.
const ownerByPartition = new Map<string, Required<WebSessionIntentOwner>>()

function closePartition(owner: WebSessionIntentOwner, worktreeId: string): string {
  return `${webSessionIntentOwnerKey(owner)}\0${worktreeId}`
}

export type WebSessionCloseIntentTicket = SessionTabCloseTicket

export function beginWebSessionCloseIntent(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabId: string,
  now: number
): WebSessionCloseIntentTicket | null {
  if (!worktreeId) {
    return null
  }
  const partition = closePartition(owner, worktreeId)
  const pairingRevision =
    owner.pairingRevision ?? getRuntimeEnvironmentRevision(owner.environmentId)
  if (pairingRevision !== undefined) {
    ownerByPartition.set(partition, { environmentId: owner.environmentId, pairingRevision })
  }
  return ledger.begin(partition, hostTabId, now)
}

export function settleWebSessionCloseIntent(
  ticket: WebSessionCloseIntentTicket,
  outcome: SessionTabCloseOutcome,
  now: number
): boolean {
  return ledger.settle(ticket, outcome, now)
}

/** Ends closes the host has confirmed and drops tabs whose close is still pending. */
export function filterWebSessionCloseIntents<T extends { id: string }>(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  tabs: readonly T[],
  topLevelIdOf: (tab: T) => string,
  now: number
): readonly T[] {
  return ledger.filter(closePartition(owner, worktreeId), tabs, topLevelIdOf, now)
}

export function isWebSessionCloseIntentPending(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabId: string,
  now: number
): boolean {
  return ledger.isPending(closePartition(owner, worktreeId), hostTabId, now)
}

export function captureWebSessionCloseIntent(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabId: string
): WebSessionCloseIntentTicket | null {
  return ledger.capture(closePartition(owner, worktreeId), hostTabId)
}

/** True when this reopen ended the matching close; a newer close still hides the tab. */
export function reopenWebSessionCloseIntent(ticket: WebSessionCloseIntentTicket): boolean {
  return ledger.reopen(ticket)
}

export function clearWebSessionCloseIntentsForWorktree(
  owner: WebSessionIntentOwner,
  worktreeId: string
): void {
  ledger.clearPartition(closePartition(owner, worktreeId))
}

/** Drops the closes of pairings that ended; a live pairing keeps its closes still in flight. */
export function clearEndedPairingWebSessionCloseIntents(): void {
  for (const [partition, owner] of ownerByPartition) {
    if (getRuntimeEnvironmentRevision(owner.environmentId) !== owner.pairingRevision) {
      ledger.clearPartition(partition)
    }
    if (!ledger.hasPending(partition)) {
      ownerByPartition.delete(partition)
    }
  }
}

export function resetWebSessionCloseIntentForTests(): void {
  ledger.reset()
  ownerByPartition.clear()
}
