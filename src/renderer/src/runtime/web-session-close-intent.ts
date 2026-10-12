// Why: closing a host's tab prunes this window's copy at once, so host lists published before the
// host handled the close must not bring it back. One shared record serves every tab kind and host.

import {
  SessionTabCloseLedger,
  type SessionTabCloseOutcome,
  type SessionTabCloseTicket
} from '../../../shared/session-tab-close-ledger'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { webSessionIntentOwnerKey, type WebSessionIntentOwner } from './web-session-intent-owner'
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import { localStructuredSessionGeneration } from './local-structured-session-tabs-sync/inventory-generation-fence'
import {
  captureHostSessionTabClosePlacement,
  type HostSessionTabClosePlacement,
  type HostSessionTabClosePlacementState
} from './host-session-tab-close-placement'

type CloseRecovery = {
  ticket: WebSessionCloseIntentTicket
  aliases: readonly WebSessionCloseIntentTicket[]
}

const ledger = new SessionTabCloseLedger<CloseRecovery>()
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
  return settleWebSessionCloseIntents([ticket], outcome, now)[0]
}

/** All aliases of one host command share its captured occurrence and operation fence. */
export function settleWebSessionCloseIntents(
  tickets: readonly WebSessionCloseIntentTicket[],
  outcome: SessionTabCloseOutcome,
  now: number
): boolean[] {
  const ticket = tickets.find((candidate) => candidate.placement) ?? tickets[0]
  const recovery = ticket ? { ticket, aliases: tickets } : undefined
  return tickets.map((alias) => ledger.settle(alias, outcome, now, recovery))
}

export function failedWebSessionCloseIntentTickets(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  now: number
): WebSessionCloseIntentTicket[] {
  const recoveries = new Set(ledger.failedRecoveries(closePartition(owner, worktreeId), now))
  return [...recoveries].flatMap(({ ticket, aliases }) =>
    isFailedWebSessionCloseIntents(aliases, now) &&
    (ticket.owner.environmentId === LOCAL_STRUCTURED_SESSION_OWNER
      ? ticket.localGeneration === localStructuredSessionGeneration()
      : ticket.owner.pairingRevision === getRuntimeEnvironmentRevision(owner.environmentId))
      ? [ticket]
      : []
  )
}

export function isFailedWebSessionCloseIntents(
  tickets: readonly WebSessionCloseIntentTicket[],
  now: number
): boolean {
  return tickets.length > 0 && tickets.every((ticket) => ledger.isFailed(ticket, now))
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
  const partition = closePartition(owner, worktreeId)
  const recoveries = ledger.failedRecoveries(partition, now)
  const confirms = (closedId: string): boolean => {
    const recovery = recoveries.find(({ aliases }) =>
      aliases.some((alias) => alias.closedId === closedId && ledger.isFailed(alias, now))
    )
    const hostTabId = recovery?.ticket.closedId ?? closedId
    // A client alias is not host omission while this action's canonical occurrence is still named.
    if (recovery && tabs.some((tab) => tab.id === hostTabId || topLevelIdOf(tab) === hostTabId)) {
      return false
    }
    return typeof confirmOmission === 'function' ? confirmOmission(hostTabId) : confirmOmission
  }
  return ledger.filter(partition, tabs, topLevelIdOf, now, confirms)
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
