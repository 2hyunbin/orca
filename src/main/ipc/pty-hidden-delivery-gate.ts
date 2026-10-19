/**
 * Main-side hidden-delivery gate for renderer PTY byte delivery (Phase 4 of
 * the terminal model/view architecture).
 *
 * Delivery is derived from positive claims: a renderer connection whose view
 * consumes the PTY's bytes (from its spawn on), or a raw-byte sidecar's
 * delivery interest. With neither, main drops
 * renderer-bound delivery AFTER model ingestion and answers the PTY's queries;
 * reveal restores from the model snapshot via the seq-guarded machinery.
 */
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  _resetRendererAttachmentsForTest,
  hasConsumingRendererAttachment
} from './pty/delivery/renderer-attachments'

export type HiddenPtyDeliveryGateSettings = Pick<
  GlobalSettings,
  'terminalMainSideEffectAuthority' | 'terminalHiddenDeliveryGate'
>

// Why: sidecar consumers (paste-draft pacing, background agent launches,
// automation observers) need live bytes even while no visible view exists. Any
// registered interest suppresses the gate for that PTY.
const deliveryInterestRendererPtys = new Map<string, Set<string>>()
const interestByPage = new Map<string, Set<string>>()
// Why: reveal must restore from the model only when bytes were actually
// dropped. Doubles as the marker latch: the first gated drop emits a restore
// marker and every new consuming view re-emits one. It retires only when the
// renderer acks the restore painted, or on PTY teardown — a replacement view may
// take the marker handler while the old one still consumes, so spending it on a
// report loses the gap. 'awaiting-paint' = a report re-emitted the marker; a drop
// after that starts a new episode the in-flight restore's snapshot may predate,
// so its ack must not retire it.
const droppedSinceHiddenPtys = new Map<
  string,
  { state: 'unrevealed' | 'awaiting-paint'; episode: number }
>()
let nextHiddenDropEpisode = 1

let droppedHiddenDeliveryChars = 0
let droppedHiddenDeliveryChunks = 0

/** Gate kill switches, both read main-side: the gate only operates under main
 *  side-effect authority AND the gate-specific setting (both default on). */
export function isHiddenPtyDeliveryGateEnabled(
  settings: HiddenPtyDeliveryGateSettings | null | undefined
): boolean {
  return (
    settings?.terminalMainSideEffectAuthority !== false &&
    settings?.terminalHiddenDeliveryGate !== false
  )
}

/** A view now consumes this PTY: returns the outstanding drop episode so its
 *  marker handler can pull the restore. Reads the latch without spending it. */
export function rearmHiddenRendererPtyRestore(id: string): number | undefined {
  const latch = droppedSinceHiddenPtys.get(id)
  if (!latch) {
    return undefined
  }
  latch.state = 'awaiting-paint'
  return latch.episode
}

/** Retires drop memory once the renderer reports painting a restore requested
 *  for this episode. An older restore's ack must not retire a newer episode,
 *  and an ack naming no episode retires nothing (fails toward recovery). */
export function consumeHiddenRendererPtyDropMemory(id: string, hiddenDropEpisode?: number): void {
  const latch = droppedSinceHiddenPtys.get(id)
  if (latch?.state === 'awaiting-paint' && latch.episode === hiddenDropEpisode) {
    droppedSinceHiddenPtys.delete(id)
  }
}

export function hasLocalRendererConsumer(id: string): boolean {
  return hasConsumingRendererAttachment(id)
}

export function hasRendererPtyDeliveryInterest(id: string): boolean {
  return deliveryInterestRendererPtys.has(id)
}

/** For diagnostics and page retire: every PTY with interest or drop state. */
export function getRendererDeliveryGatePtyIds(): string[] {
  return [...new Set([...deliveryInterestRendererPtys.keys(), ...droppedSinceHiddenPtys.keys()])]
}

/** Renderer-side ref-counted interest, surfaced as boolean transitions. */
export function setRendererPtyDeliveryInterest(
  id: string,
  interested: boolean,
  page: string
): void {
  const interests = interestByPage.get(page) ?? new Set<string>()
  if (interested) {
    interests.add(id)
  } else {
    interests.delete(id)
  }
  if (interests.size) {
    interestByPage.set(page, interests)
  } else {
    interestByPage.delete(page)
  }
  const owners = deliveryInterestRendererPtys.get(id) ?? new Set<string>()
  if (interested) {
    owners.add(page)
  } else {
    owners.delete(page)
  }
  if (owners.size) {
    deliveryInterestRendererPtys.set(id, owners)
  } else {
    deliveryInterestRendererPtys.delete(id)
  }
}

export function shouldDropRendererPtyData(
  id: string,
  settings: HiddenPtyDeliveryGateSettings | null | undefined
): boolean {
  return (
    isHiddenPtyDeliveryGateEnabled(settings) &&
    !hasLocalRendererConsumer(id) &&
    !deliveryInterestRendererPtys.has(id)
  )
}

/** Record one gated drop. Returns whether the caller should emit the one-shot
 *  empty restore-marker chunk (first drop since the latch was retired or last revealed). */
export function recordHiddenRendererPtyDataDrop(
  id: string,
  chars: number
): { shouldEmitRestoreMarker: boolean; hiddenDropEpisode: number } {
  droppedHiddenDeliveryChars += chars
  droppedHiddenDeliveryChunks += 1
  const latch = droppedSinceHiddenPtys.get(id)
  if (latch?.state === 'unrevealed') {
    return { shouldEmitRestoreMarker: false, hiddenDropEpisode: latch.episode }
  }
  const episode = nextHiddenDropEpisode++
  droppedSinceHiddenPtys.set(id, { state: 'unrevealed', episode })
  return { shouldEmitRestoreMarker: true, hiddenDropEpisode: episode }
}

/** The renderer page died with its interest holds; drop memory stays for the successor's restore. */
export function deleteRendererPtyDeliveryInterestForPage(page: string): void {
  for (const id of interestByPage.get(page) ?? []) {
    setRendererPtyDeliveryInterest(id, false, page)
  }
}

/** Full per-PTY teardown — wired into clearProviderPtyState so every exit
 *  path (local, daemon, SSH, connection teardown) releases gate state. */
export function clearHiddenRendererPtyDeliveryState(id: string): void {
  for (const page of deliveryInterestRendererPtys.get(id) ?? []) {
    setRendererPtyDeliveryInterest(id, false, page)
  }
  droppedSinceHiddenPtys.delete(id)
}

export type HiddenRendererPtyDeliveryDebug = {
  deliveryInterestPtyCount: number
  hiddenDeliveryDroppedChars: number
  hiddenDeliveryDroppedChunks: number
}

export function getHiddenRendererPtyDeliveryDebug(): HiddenRendererPtyDeliveryDebug {
  return {
    deliveryInterestPtyCount: deliveryInterestRendererPtys.size,
    hiddenDeliveryDroppedChars: droppedHiddenDeliveryChars,
    hiddenDeliveryDroppedChunks: droppedHiddenDeliveryChunks
  }
}

export function resetHiddenRendererPtyDeliveryDebugCounters(): void {
  droppedHiddenDeliveryChars = 0
  droppedHiddenDeliveryChunks = 0
}

/** Test seam: reset all module state between tests. */
export function _resetHiddenRendererPtyDeliveryGateForTest(): void {
  deliveryInterestRendererPtys.clear()
  interestByPage.clear()
  droppedSinceHiddenPtys.clear()
  resetHiddenRendererPtyDeliveryDebugCounters()
  _resetRendererAttachmentsForTest()
}
