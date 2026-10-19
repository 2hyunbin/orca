import { getPtyIpc } from '../../pty-host-bindings'
import { redactPtyIdForDiagnostics } from '../../../../shared/pty-delivery-diagnostics'
import {
  deleteRendererPtyDeliveryInterestForPage,
  getRendererDeliveryGatePtyIds,
  rearmHiddenRendererPtyRestore,
  recordHiddenRendererPtyDataDrop,
  shouldDropRendererPtyData
} from '../../pty-hidden-delivery-gate'
import { closeStartupQueryAuthorityForPty, tryGetProviderForPty } from '../provider/registry'
import {
  hasLocalVisibleRendererView,
  invalidatePendingPtyDrainPolicy
} from '../delivery/visibility-state'
import { mainDeliveryBreadcrumbs } from '../delivery/debug'
import { sendModelRestoreNeededMarker } from '../delivery/payload'
import {
  closeRendererAttachment,
  deleteRendererAttachmentsForPage,
  getRendererAttachmentPtyIds,
  openRendererAttachment,
  updateRendererAttachment,
  type RendererAttachmentState
} from '../delivery/renderer-attachments'
import { isAdmittedRendererPage, openRendererPage } from '../delivery/renderer-page'
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

/** Applies one attachment mutation and re-derives what it changed for each affected PTY. */
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
    // A surviving known-id attach needs pacing even before this session has cached a hint.
    if (next.visibleView !== previous.visibleView && tryGetProviderForPty(id)?.hasPty?.(id)) {
      session.syncPtyBackgroundedDelivery(id, 'attachment')
    }
  }
}

/** Everything the retired page attached dies with it; drop memory stays for its successor. */
export function retireRendererPageClaims(session: PtyIpcSession, page: string): void {
  mainDeliveryBreadcrumbs.record('renderer-page-retired')
  const ids = new Set([...getRendererDeliveryGatePtyIds(), ...getRendererAttachmentPtyIds()])
  changeRendererPtyClaims(session, [...ids], () => {
    deleteRendererPtyDeliveryInterestForPage(page)
    deleteRendererAttachmentsForPage(page)
  })
  session.resyncBackgroundedDeliveriesAfterGateReset()
}

function readAttachmentState(args: {
  consuming?: unknown
  visible?: unknown
}): Partial<RendererAttachmentState> {
  return {
    ...(typeof args.consuming === 'boolean' ? { consuming: args.consuming } : {}),
    ...(typeof args.visible === 'boolean' ? { visible: args.visible } : {})
  }
}

/** A view's own report: it may now pull an outstanding restore, and a visible view answers startup queries. */
function applyViewReport(
  session: PtyIpcSession,
  ptyId: string | null | undefined,
  state: Partial<RendererAttachmentState>
): void {
  if (!ptyId) {
    return
  }
  if (state.visible === true) {
    closeStartupQueryAuthorityForPty(ptyId)
  }
  const episode = state.consuming === true ? rearmHiddenRendererPtyRestore(ptyId) : undefined
  // Why every consuming report: the marker handler belongs to the newest view, which may replace
  // one that still consumes; a redundant replay is cheap, a missed restore is not.
  if (episode !== undefined) {
    sendModelRestoreNeededMarker(
      session,
      ptyId,
      'unhide',
      session.runtime?.getPtyOutputSequence(ptyId),
      episode
    )
  }
}

type AttachmentMessage = {
  page?: unknown
  key?: unknown
  ptyId?: unknown
  consuming?: unknown
  visible?: unknown
}

export function installRendererAttachmentIpc(session: PtyIpcSession): void {
  const ipcMain = getPtyIpc()
  const { mainWindow } = session
  ipcMain.removeAllListeners('pty:openRendererPage')
  ipcMain.on('pty:openRendererPage', (event, args: { correlation?: unknown }) => {
    openRendererPage(event, mainWindow, args?.correlation)
  })

  ipcMain.removeAllListeners('pty:openRendererAttachment')
  ipcMain.on('pty:openRendererAttachment', (event, args: AttachmentMessage) => {
    const { key, ptyId } = args ?? {}
    if (
      typeof key !== 'string' ||
      typeof ptyId !== 'string' ||
      !ptyId ||
      !isAdmittedRendererPage(event, mainWindow, args.page)
    ) {
      return
    }
    const state = readAttachmentState(args)
    openRendererAttachment(args.page, key, ptyId, {
      consuming: state.consuming === true,
      visible: state.visible === true
    })
    applyViewReport(session, ptyId, state)
  })

  ipcMain.removeAllListeners('pty:updateRendererAttachment')
  ipcMain.on('pty:updateRendererAttachment', (event, args: AttachmentMessage) => {
    const key = args?.key
    if (typeof key !== 'string' || !isAdmittedRendererPage(event, mainWindow, args.page)) {
      return
    }
    const state = readAttachmentState(args)
    const ptyId = updateRendererAttachment(args.page, key, state)
    if (ptyId && state.consuming !== undefined) {
      mainDeliveryBreadcrumbs.record(state.consuming ? 'gate-unmark' : 'gate-mark', {
        id: redactPtyIdForDiagnostics(ptyId)
      })
    }
    applyViewReport(session, ptyId, state)
  })

  ipcMain.removeAllListeners('pty:closeRendererAttachment')
  ipcMain.on('pty:closeRendererAttachment', (event, args: AttachmentMessage) => {
    const key = args?.key
    if (typeof key === 'string' && isAdmittedRendererPage(event, mainWindow, args.page)) {
      closeRendererAttachment(args.page, key)
    }
  })
}
