import { getPtyIpc } from '../../pty-host-bindings'
import { redactPtyIdForDiagnostics } from '../../../../shared/pty-delivery-diagnostics'
import {
  clearRendererScopedPtyDeliveryClaims,
  getRendererDeliveryGatePtyIds,
  recordHiddenRendererPtyDataDrop,
  setRendererPtyConsumer,
  shouldDropRendererPtyData
} from '../../pty-hidden-delivery-gate'
import { closeStartupQueryAuthorityForPty } from '../provider/registry'
import {
  hasLocalVisibleRendererView,
  invalidatePendingPtyDrainPolicy,
  visibleRendererPtys
} from '../delivery/visibility-state'
import { mainDeliveryBreadcrumbs } from '../delivery/debug'
import { sendModelRestoreNeededMarker } from '../delivery/payload'
import {
  deleteSpawnConsumerClaimsForDocument,
  getSpawnConsumerClaimPtyIds,
  settleSpawnConsumerClaim
} from '../delivery/spawn-consumer-claims'
import { admitRendererDocument } from '../delivery/renderer-document'
import type { PtyIpcSession } from '../session'

type RendererPtyClaimState = { droppable: boolean; visibleView: boolean }

function readClaimState(session: PtyIpcSession, id: string): RendererPtyClaimState {
  return {
    droppable: shouldDropRendererPtyData(id, session.getSettings?.()),
    visibleView: hasLocalVisibleRendererView(id)
  }
}

function dropPendingForNewlyGatedPty(session: PtyIpcSession, id: string): void {
  closeStartupQueryAuthorityForPty(id)
  // Why: drop bytes queued for a newly gated PTY instead of holding them under ACK starvation; reveal restores from the snapshot.
  const pending = session.pendingData.get(id)
  if (!pending) {
    return
  }
  session.pendingData.delete(id)
  session.updateProducerFlowControl(id)
  session.pendingOverflowMarkedPtys.delete(id)
  const drop = recordHiddenRendererPtyDataDrop(id, pending.data.length)
  if (drop.shouldEmitRestoreMarker) {
    sendModelRestoreNeededMarker(
      session,
      id,
      'hidden-drop',
      session.runtime?.getPtyOutputSequence(id),
      drop.hiddenDropEpisode
    )
  }
}

/** Applies one claim mutation and re-derives what it changed for each affected PTY. */
export function changeRendererPtyClaims(
  session: PtyIpcSession,
  ids: readonly string[],
  mutate: () => void
): void {
  const before = new Map(ids.map((id) => [id, readClaimState(session, id)]))
  mutate()
  for (const [id, previous] of before) {
    const next = readClaimState(session, id)
    if (next.droppable !== previous.droppable) {
      if (next.droppable) {
        dropPendingForNewlyGatedPty(session, id)
      }
      invalidatePendingPtyDrainPolicy(id)
    }
    // Why has(): a fresh id takes its first pacing state at registration, once it routes.
    if (
      next.visibleView !== previous.visibleView &&
      session.backgroundedDeliverySyncByPty.has(id)
    ) {
      session.syncPtyBackgroundedDelivery(id, 'spawn-claim')
    }
  }
}

/** Everything the retired page claimed dies with it; drop memory stays for its successor. */
export function retireRendererDocumentClaims(session: PtyIpcSession, doc: string): void {
  mainDeliveryBreadcrumbs.record('renderer-document-retired')
  const ids = new Set([
    ...getRendererDeliveryGatePtyIds(),
    ...getSpawnConsumerClaimPtyIds(),
    ...visibleRendererPtys
  ])
  changeRendererPtyClaims(session, [...ids], () => {
    clearRendererScopedPtyDeliveryClaims()
    deleteSpawnConsumerClaimsForDocument(doc)
    visibleRendererPtys.clear()
  })
  session.resyncBackgroundedDeliveriesAfterGateReset()
}

export function installRendererConsumerIpc(session: PtyIpcSession): void {
  const ipcMain = getPtyIpc()
  ipcMain.removeAllListeners('pty:setRendererPtyConsumer')
  ipcMain.on(
    'pty:setRendererPtyConsumer',
    (_event, args: { doc?: unknown; id?: unknown; consuming?: unknown }) => {
      const id = args?.id
      if (typeof id !== 'string' || !id || !admitRendererDocument(args.doc)) {
        return
      }
      const consuming = args.consuming === true
      mainDeliveryBreadcrumbs.record(consuming ? 'gate-unmark' : 'gate-mark', {
        id: redactPtyIdForDiagnostics(id)
      })
      let restoreEpisode: number | undefined
      changeRendererPtyClaims(session, [id], () => {
        restoreEpisode = setRendererPtyConsumer(id, consuming)
      })
      // Why every view's report: the marker handler belongs to the newest view, which may
      // replace one that still consumes; a redundant replay is cheap, a missed restore is not.
      if (restoreEpisode !== undefined) {
        sendModelRestoreNeededMarker(
          session,
          id,
          'unhide',
          session.runtime?.getPtyOutputSequence(id),
          restoreEpisode
        )
      }
    }
  )

  ipcMain.removeAllListeners('pty:settleSpawnConsumerClaim')
  ipcMain.on('pty:settleSpawnConsumerClaim', (_event, args: { doc?: unknown; token?: unknown }) => {
    if (typeof args?.token !== 'number' || !admitRendererDocument(args.doc)) {
      return
    }
    settleSpawnConsumerClaim(args.doc, args.token)
  })
}
