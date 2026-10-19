import { redactPtyIdForDiagnostics } from '../../../../shared/pty-delivery-diagnostics'
import { recordTerminalFreezeBreadcrumb } from './terminal-freeze-breadcrumbs'

type VisibilityClaim = { ptyId: string; visible: boolean }
type ConsumerClaim = { ptyId: string; consuming: boolean }

declare const visibilityClaimOwnerBrand: unique symbol

/** The mounted transport holding a claim; only its reference is ever compared. */
export type RendererPtyVisibilityClaimOwner = object & {
  readonly [visibilityClaimOwnerBrand]?: never
}

/** One connect's pending visible consumer: minted at dispatch, settled exactly once. */
export type SpawnConsumerAttempt = {
  readonly owner: RendererPtyVisibilityClaimOwner
  readonly wantsClaim: boolean
  readonly isLive: () => boolean
  token: number | null
  settled: boolean
  handedOff: boolean
}

const visibilityClaimsByOwner = new Map<RendererPtyVisibilityClaimOwner, VisibilityClaim>()
const visibleClaimCounts = new Map<string, number>()
const consumerClaimsByOwner = new Map<RendererPtyVisibilityClaimOwner, ConsumerClaim>()
const consumingClaimCounts = new Map<string, number>()
// Why a slot: the spawn's claim must outlive the reply until the accepted id has this owner's report.
const pendingSpawnSlots = new Map<RendererPtyVisibilityClaimOwner, SpawnConsumerAttempt>()
let retiredOwners = new WeakSet<RendererPtyVisibilityClaimOwner>()
let nextSpawnConsumerToken = 1

function ptyApi(): Window['api']['pty'] | undefined {
  return (globalThis as { window?: Window }).window?.api?.pty
}

function sendConsumer(ptyId: string, consuming: boolean): void {
  recordTerminalFreezeBreadcrumb(consuming ? 'renderer-gate-unmark' : 'renderer-gate-mark', {
    id: redactPtyIdForDiagnostics(ptyId)
  })
  ptyApi()?.setRendererPtyConsumer?.(ptyId, consuming)
}

function sendVisibility(ptyId: string, visible: boolean): void {
  ptyApi()?.setRendererPtyVisible?.(ptyId, visible)
}

export function createSpawnConsumerAttempt(
  owner: RendererPtyVisibilityClaimOwner,
  wantsClaim: boolean,
  isLive: () => boolean
): SpawnConsumerAttempt {
  return { owner, wantsClaim, isLive, token: null, settled: false, handedOff: false }
}

/** Mints the token right before the spawn IPC leaves; a dead attempt sends none. */
export function admitSpawnConsumerAttempt(attempt: SpawnConsumerAttempt): number | undefined {
  if (
    !attempt.wantsClaim ||
    attempt.token !== null ||
    attempt.settled ||
    retiredOwners.has(attempt.owner) ||
    !attempt.isLive()
  ) {
    return undefined
  }
  attempt.token = nextSpawnConsumerToken++
  return attempt.token
}

function settleAttempt(attempt: SpawnConsumerAttempt): void {
  if (attempt.token === null || attempt.settled) {
    return
  }
  attempt.settled = true
  ptyApi()?.settleSpawnConsumerClaim?.(attempt.token)
}

/** The connect's own cleanup for every outcome that did not hand the claim to its owner. */
export function settleUnhandedSpawnConsumerAttempt(attempt: SpawnConsumerAttempt): void {
  if (!attempt.handedOff) {
    settleAttempt(attempt)
  }
}

function settlePendingSpawnSlot(owner: RendererPtyVisibilityClaimOwner): void {
  const slot = pendingSpawnSlots.get(owner)
  if (slot) {
    pendingSpawnSlots.delete(owner)
    settleAttempt(slot)
  }
}

/** Success return: settle once the accepted id carries this owner's consumer report. */
export function handOffSpawnConsumerAttempt(attempt: SpawnConsumerAttempt, ptyId: string): void {
  attempt.handedOff = true
  if (attempt.token === null || attempt.settled) {
    return
  }
  settlePendingSpawnSlot(attempt.owner)
  if (
    retiredOwners.has(attempt.owner) ||
    consumerClaimsByOwner.get(attempt.owner)?.ptyId === ptyId
  ) {
    settleAttempt(attempt)
    return
  }
  pendingSpawnSlots.set(attempt.owner, attempt)
}

/** A rejected reattach will never report for the accepted id. */
export function abandonSpawnConsumerAttempt(owner: RendererPtyVisibilityClaimOwner): void {
  settlePendingSpawnSlot(owner)
}

function removeConsumingClaim(claim: ConsumerClaim | undefined): void {
  if (!claim?.consuming) {
    return
  }
  const currentCount = consumingClaimCounts.get(claim.ptyId) ?? 0
  if (currentCount <= 1) {
    consumingClaimCounts.delete(claim.ptyId)
    sendConsumer(claim.ptyId, false)
    return
  }
  consumingClaimCounts.set(claim.ptyId, currentCount - 1)
}

/**
 * Reports whether one mounted transport consumes a PTY's bytes. Every newly
 * consuming owner reports, so main can re-offer a restore to the newest marker
 * handler; main hears "not consuming" only when no owner consumes.
 */
export function setRendererPtyConsumerClaim(
  owner: RendererPtyVisibilityClaimOwner,
  ptyId: string,
  consuming: boolean
): void {
  const previous = consumerClaimsByOwner.get(owner)
  if (previous?.ptyId !== ptyId || previous.consuming !== consuming) {
    removeConsumingClaim(previous)
    consumerClaimsByOwner.set(owner, { ptyId, consuming })
    if (consuming) {
      consumingClaimCounts.set(ptyId, (consumingClaimCounts.get(ptyId) ?? 0) + 1)
      sendConsumer(ptyId, true)
    }
  }
  // Why after the report: IPC order lands this owner's claim before the spawn claim ends.
  settlePendingSpawnSlot(owner)
}

/** The PTY ended or the pane stopped syncing it; the spawn slot is not touched. */
export function clearRendererPtyConsumerClaim(owner: RendererPtyVisibilityClaimOwner): void {
  const previous = consumerClaimsByOwner.get(owner)
  consumerClaimsByOwner.delete(owner)
  removeConsumingClaim(previous)
}

function removeVisibleClaim(claim: VisibilityClaim): boolean {
  if (!claim.visible) {
    return false
  }
  const currentCount = visibleClaimCounts.get(claim.ptyId) ?? 0
  if (currentCount <= 1) {
    visibleClaimCounts.delete(claim.ptyId)
    return true
  }
  visibleClaimCounts.set(claim.ptyId, currentCount - 1)
  return false
}

/**
 * Reports one mounted transport's visibility. Ref-counting by owner prevents
 * a retiring pane from hiding a PTY after its replacement has already bound.
 */
export function setRendererPtyVisibilityClaim(
  owner: RendererPtyVisibilityClaimOwner,
  ptyId: string,
  visible: boolean
): void {
  const previous = visibilityClaimsByOwner.get(owner)
  if (previous?.ptyId === ptyId && previous.visible === visible) {
    return
  }

  if (previous) {
    const becameHidden = removeVisibleClaim(previous)
    if (becameHidden && previous.ptyId !== ptyId) {
      sendVisibility(previous.ptyId, false)
    }
  }

  visibilityClaimsByOwner.set(owner, { ptyId, visible })
  if (visible) {
    const nextCount = (visibleClaimCounts.get(ptyId) ?? 0) + 1
    visibleClaimCounts.set(ptyId, nextCount)
    if (nextCount === 1) {
      sendVisibility(ptyId, true)
    }
    return
  }

  if (!visibleClaimCounts.has(ptyId)) {
    sendVisibility(ptyId, false)
  }
}

/** Visibility only: the tab-visibility effect re-runs this on every flip, so it must keep spawn claims. */
export function releaseRendererPtyVisibilityClaim(owner: RendererPtyVisibilityClaimOwner): void {
  const previous = visibilityClaimsByOwner.get(owner)
  if (!previous) {
    return
  }
  visibilityClaimsByOwner.delete(owner)
  if (removeVisibleClaim(previous)) {
    sendVisibility(previous.ptyId, false)
  }
}

/** Real transport disposal: every claim this owner holds ends, and later hand-offs settle at once. */
export function releaseRendererPtyOwnerClaims(owner: RendererPtyVisibilityClaimOwner): void {
  retiredOwners.add(owner)
  releaseRendererPtyVisibilityClaim(owner)
  clearRendererPtyConsumerClaim(owner)
  settlePendingSpawnSlot(owner)
}

/** Test seam: renderer reload naturally clears these module-scoped claims. */
export function _resetPtyRendererDeliveryClaimsForTest(): void {
  visibilityClaimsByOwner.clear()
  visibleClaimCounts.clear()
  consumerClaimsByOwner.clear()
  consumingClaimCounts.clear()
  pendingSpawnSlots.clear()
  retiredOwners = new WeakSet()
}
