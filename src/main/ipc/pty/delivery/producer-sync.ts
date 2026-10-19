import { recordDaemonStreamBacklogEvent } from '../../../daemon/daemon-stream-backlog-probe'
import { hasLocalRendererConsumer } from '../../pty-hidden-delivery-gate'
import { closeStartupQueryAuthorityForPty, tryGetProviderForPty } from '../provider/registry'
import { hasLocalVisibleRendererView, PRODUCER_FLOW_CONTROL_ENABLED } from './visibility-state'
import type { PtyIpcSession } from '../session'

export function updateProducerFlowControl(session: PtyIpcSession, id: string): void {
  if (!PRODUCER_FLOW_CONTROL_ENABLED) {
    return
  }
  session.producerFlowControl.update(id, session.pendingData.get(id)?.data.length ?? 0)
}

export function syncPtyBackgroundedDelivery(
  session: PtyIpcSession,
  id: string,
  caller: string
): void {
  // Why: no local view on screen paces the producer unless a raw remote viewer still watches it.
  const visible = hasLocalVisibleRendererView(id)
  const background = !visible && !(session.runtime?.hasRawTerminalViewSubscriber?.(id) ?? false)
  if (session.backgroundedDeliverySyncByPty.get(id) === background) {
    return
  }
  const provider = tryGetProviderForPty(id)
  if (!provider?.setPtyBackgrounded) {
    return
  }
  recordDaemonStreamBacklogEvent('mainBackgroundSync', {
    sessionIdSuffix: id.slice(-10),
    background,
    caller,
    visible
  })
  const previous = session.backgroundedDeliverySyncByPty.get(id)
  session.backgroundedDeliverySyncByPty.set(id, background)
  try {
    provider.setPtyBackgrounded(id, background)
  } catch (error) {
    // Why: a recorded state the provider never took would short-circuit every later sync for this PTY.
    if (previous === undefined) {
      session.backgroundedDeliverySyncByPty.delete(id)
    } else {
      session.backgroundedDeliverySyncByPty.set(id, previous)
    }
    console.error('[pty] setPtyBackgrounded failed; delivery sync state rolled back', error)
  }
}

export function resyncBackgroundedDeliveriesAfterGateReset(session: PtyIpcSession): void {
  for (const id of session.backgroundedDeliverySyncByPty.keys()) {
    syncPtyBackgroundedDelivery(session, id, 'gate-reset')
  }
}

/** Once the PTY routes by ownership: apply current pacing, and hand startup queries to main when no view consumes. */
export function syncPtyDeliveryAfterRegistration(
  deps: { syncPtyBackgroundedDelivery?: (id: string, caller: string) => void },
  id: string
): void {
  deps.syncPtyBackgroundedDelivery?.(id, 'spawn')
  if (!hasLocalRendererConsumer(id)) {
    closeStartupQueryAuthorityForPty(id)
  }
}
