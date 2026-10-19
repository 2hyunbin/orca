import { getAppEnvironment } from '../../../../shared/app-environment'
import {
  type PtyMainDeliveryDiagnostics,
  type PtyPerPtyDeliveryDiagnostics,
  redactPtyIdForDiagnostics
} from '../../../../shared/pty-delivery-diagnostics'
import {
  getHiddenRendererPtyDeliveryDebug,
  getRendererDeliveryGatePtyIds,
  shouldDropRendererPtyData
} from '../../pty-hidden-delivery-gate'
import { ptyOwnership } from '../provider/ownership-state'
import { getRendererAttachmentPtyIds } from './renderer-attachments'
import {
  lastPowerResumeAtMs,
  lastPowerSuspendAtMs,
  mainDeliveryBreadcrumbs,
  type PtyRendererDeliveryDebugSnapshot
} from './debug'
import { activeRendererPtys, hasLocalVisibleRendererView } from './visibility-state'
import { DELIVERY_DIAGNOSTICS_MAX_PTYS } from './constants'
import type { PtyIpcSession } from '../session'

/** Every PTY delivery could concern, so a pty gated before its first byte still surfaces (the wedge case). */
function collectDeliveryDiagnosticPtyIds(session: PtyIpcSession): Set<string> {
  return new Set([
    ...session.rendererDeliveryAccountingByPty.keys(),
    ...session.pendingData.keys(),
    ...activeRendererPtys,
    ...getRendererDeliveryGatePtyIds(),
    ...getRendererAttachmentPtyIds(),
    ...ptyOwnership.keys()
  ])
}

export function buildMainDeliveryDiagnostics(session: PtyIpcSession): PtyMainDeliveryDiagnostics {
  const now = Date.now()
  const settings = session.getSettings?.()
  const ids = collectDeliveryDiagnosticPtyIds(session)
  const perPty: PtyPerPtyDeliveryDiagnostics[] = []
  for (const id of ids) {
    const accounting = session.rendererDeliveryAccountingByPty.get(id)
    perPty.push({
      id: redactPtyIdForDiagnostics(id),
      sentChars: accounting?.sentChars ?? 0,
      ackedChars: accounting?.ackedChars ?? 0,
      inFlightChars: accounting ? accounting.sentChars - accounting.ackedChars : 0,
      pendingChars: session.pendingData.get(id)?.data.length ?? 0,
      hidden: shouldDropRendererPtyData(id, settings),
      visible: hasLocalVisibleRendererView(id),
      active: activeRendererPtys.has(id),
      msSinceLastSend: accounting ? now - accounting.lastSendAtMs : null,
      msSinceLastAck: accounting?.lastAckAtMs == null ? null : now - accounting.lastAckAtMs
    })
  }
  perPty.sort((a, b) => b.inFlightChars + b.pendingChars - (a.inFlightChars + a.pendingChars))
  const { mainWindow } = session
  const windowAlive = mainWindow && !mainWindow.isDestroyed()
  return {
    appVersion: getAppEnvironment().getVersion(),
    mainUptimeMs: Math.round(process.uptime() * 1000),
    windowFocused: windowAlive ? mainWindow.isFocused() : null,
    windowVisible: windowAlive ? mainWindow.isVisible() : null,
    windowMinimized: windowAlive ? mainWindow.isMinimized() : null,
    msSinceLastPowerSuspend: lastPowerSuspendAtMs === null ? null : now - lastPowerSuspendAtMs,
    msSinceLastPowerResume: lastPowerResumeAtMs === null ? null : now - lastPowerResumeAtMs,
    perPty: perPty.slice(0, DELIVERY_DIAGNOSTICS_MAX_PTYS),
    breadcrumbs: mainDeliveryBreadcrumbs.snapshot()
  }
}

export function readCurrentPtyRendererDeliveryDebugSnapshot(
  session: PtyIpcSession
): PtyRendererDeliveryDebugSnapshot {
  let pendingChars = 0
  let maxPendingCharsByPty = 0
  for (const pending of session.pendingData.values()) {
    const chars = pending.data.length
    pendingChars += chars
    maxPendingCharsByPty = Math.max(maxPendingCharsByPty, chars)
  }
  const hiddenDeliveryDebug = getHiddenRendererPtyDeliveryDebug()
  let rendererInFlightPtyCount = 0
  let maxRendererInFlightCharsByPty = 0
  for (const accounting of session.rendererDeliveryAccountingByPty.values()) {
    const inFlight = accounting.sentChars - accounting.ackedChars
    if (inFlight > 0) {
      rendererInFlightPtyCount++
    }
    maxRendererInFlightCharsByPty = Math.max(maxRendererInFlightCharsByPty, inFlight)
  }
  const settings = session.getSettings?.()
  let hiddenDeliveryGatedPtyCount = 0
  for (const id of collectDeliveryDiagnosticPtyIds(session)) {
    if (shouldDropRendererPtyData(id, settings)) {
      hiddenDeliveryGatedPtyCount++
    }
  }
  // Why: a pty both gated and reported visible means main is starving a visible pane (v1.4.124-rc.2.perf field lead).
  let hiddenDeliveryGatedVisiblePtyCount = 0
  for (const id of getRendererAttachmentPtyIds()) {
    if (hasLocalVisibleRendererView(id) && shouldDropRendererPtyData(id, settings)) {
      hiddenDeliveryGatedVisiblePtyCount++
    }
  }
  let hiddenDeliveryGatedActivePtyCount = 0
  for (const id of activeRendererPtys) {
    if (shouldDropRendererPtyData(id, settings)) {
      hiddenDeliveryGatedActivePtyCount++
    }
  }
  return {
    pendingPtyCount: session.pendingData.size,
    pendingChars,
    maxPendingCharsByPty,
    rendererInFlightPtyCount,
    rendererInFlightChars: session.rendererInFlightTotalChars,
    maxRendererInFlightCharsByPty,
    activeRendererPtyCount: activeRendererPtys.size,
    flushScheduled: session.flushTimer !== null,
    peakPendingChars: session.peakPendingChars,
    peakMaxPendingCharsByPty: session.peakMaxPendingCharsByPty,
    peakRendererInFlightChars: session.peakRendererInFlightChars,
    peakMaxRendererInFlightCharsByPty: session.peakMaxRendererInFlightCharsByPty,
    ackGatedFlushSkipCount: session.ackGatedFlushSkipCount,
    ...hiddenDeliveryDebug,
    hiddenDeliveryGatedPtyCount,
    hiddenDeliveryGatedVisiblePtyCount,
    hiddenDeliveryGatedActivePtyCount,
    pendingDroppedChars: session.pendingDroppedChars,
    diagnostics: buildMainDeliveryDiagnostics(session),
    rendererLifecycleResetCount: session.rendererLifecycleResetCount,
    lastLifecycleResetClearedChars: session.lastLifecycleResetClearedChars,
    rendererPtyDispatcherReady: session.rendererPtyDispatcherReady,
    rendererDispatcherReadyForcedCount: session.rendererDispatcherReadyForcedCount
  }
}

export function seedPtyRendererDeliveryPeaksFromCurrentState(session: PtyIpcSession): void {
  let pendingChars = 0
  let maxPendingCharsByPty = 0
  for (const pending of session.pendingData.values()) {
    const chars = pending.data.length
    pendingChars += chars
    maxPendingCharsByPty = Math.max(maxPendingCharsByPty, chars)
  }
  session.peakPendingChars = pendingChars
  session.peakMaxPendingCharsByPty = maxPendingCharsByPty
  session.peakRendererInFlightChars = session.rendererInFlightTotalChars
  let maxRendererInFlightCharsByPty = 0
  for (const accounting of session.rendererDeliveryAccountingByPty.values()) {
    maxRendererInFlightCharsByPty = Math.max(
      maxRendererInFlightCharsByPty,
      accounting.sentChars - accounting.ackedChars
    )
  }
  session.peakMaxRendererInFlightCharsByPty = maxRendererInFlightCharsByPty
}

export function warnIfDroppingHiddenBytesForVisiblePty(
  session: PtyIpcSession,
  id: string,
  droppedChars: number
): void {
  if (!hasLocalVisibleRendererView(id) && !activeRendererPtys.has(id)) {
    return
  }
  // Recorded before the warn rate limit: the ring coalesces repeats, and the contradiction must appear in the freeze report either way.
  mainDeliveryBreadcrumbs.record('hidden-drop-visible', {
    id: redactPtyIdForDiagnostics(id),
    droppedChars
  })
  const now = Date.now()
  if (now - session.lastHiddenDropContradictionWarnAtMs < 60_000) {
    return
  }
  session.lastHiddenDropContradictionWarnAtMs = now
  console.warn('[pty] hidden-delivery gate is dropping bytes for a visible/active pty', {
    id: redactPtyIdForDiagnostics(id),
    droppedChars,
    visible: hasLocalVisibleRendererView(id),
    active: activeRendererPtys.has(id),
    ...readCurrentPtyRendererDeliveryDebugSnapshot(session)
  })
}
