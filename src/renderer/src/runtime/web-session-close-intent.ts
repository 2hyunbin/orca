// Why: closing a host's tab prunes this window's copy at once, so host lists published before the
// host handled the close must not bring it back. One shared record serves every tab kind and host.

import {
  SessionTabCloseLedger,
  type SessionTabCloseOutcome,
  type SessionTabCloseTicket
} from '../../../shared/session-tab-close-ledger'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { webSessionIntentOwnerKey, type WebSessionIntentOwner } from './web-session-intent-owner'
import { localStructuredSessionGeneration } from './local-structured-session-tabs-sync/inventory-generation-fence'
import {
  captureHostSessionTabClosePlacement,
  type HostSessionTabClosePlacement,
  type HostSessionTabClosePlacementState
} from './host-session-tab-close-placement'

const ledger = new SessionTabCloseLedger()
let readClosePlacementState: (() => HostSessionTabClosePlacementState) | undefined

// Store slices import close records; bind the reader only after store creation finishes.
export function registerWebSessionClosePlacementStateReader(
  reader: () => HostSessionTabClosePlacementState
): void {
  readClosePlacementState = reader
}
// The pairing each partition was recorded under, so an ended pairing's closes can be found.
const ownerByPartition = new Map<string, Required<WebSessionIntentOwner>>()

function closePartition(owner: WebSessionIntentOwner, worktreeId: string): string {
  return `${webSessionIntentOwnerKey(owner)}\0${worktreeId}`
}

export type WebSessionCloseIntentTicket = SessionTabCloseTicket & {
  owner: WebSessionIntentOwner
  worktreeId: string
  localGeneration: number
  placement?: HostSessionTabClosePlacement
}

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
  const ticket = ledger.begin(partition, hostTabId, now)
  if (!ticket) {
    return null
  }
  let placement: HostSessionTabClosePlacement | undefined
  try {
    if (!readClosePlacementState) {
      throw new Error('closed tab placement state reader is not registered')
    }
    placement = captureHostSessionTabClosePlacement(
      readClosePlacementState(),
      owner.environmentId,
      worktreeId,
      hostTabId
    )
  } catch (error) {
    console.warn('[session-tabs] could not capture closed tab position', error)
  }
  return {
    ...ticket,
    owner: { environmentId: owner.environmentId, pairingRevision },
    worktreeId,
    localGeneration: localStructuredSessionGeneration(),
    placement
  }
}

export function settleWebSessionCloseIntent(
  ticket: WebSessionCloseIntentTicket,
  outcome: SessionTabCloseOutcome,
  now: number
): boolean {
  return ledger.settle(ticket, outcome, now)
}

export function takeFailedWebSessionCloseIntent(
  ticket: WebSessionCloseIntentTicket,
  now: number
): boolean {
  return ledger.takeFailed(ticket, now)
}

/** Ends closes the host has confirmed and drops tabs whose close is still pending. */
export function filterWebSessionCloseIntents<T extends { id: string }>(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  tabs: readonly T[],
  topLevelIdOf: (tab: T) => string,
  now: number,
  confirmOmission: boolean | ((closedId: string) => boolean) = true
): readonly T[] {
  return ledger.filter(closePartition(owner, worktreeId), tabs, topLevelIdOf, now, confirmOmission)
}

export function isWebSessionCloseIntentPending(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabId: string,
  now: number
): boolean {
  return ledger.isPending(closePartition(owner, worktreeId), hostTabId, now)
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
    if (!ledger.hasPending(partition, Date.now())) {
      ownerByPartition.delete(partition)
    }
  }
}

export function resetWebSessionCloseIntentForTests(): void {
  ledger.reset()
  ownerByPartition.clear()
}
