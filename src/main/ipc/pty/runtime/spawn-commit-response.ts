import type { RuntimePtySpawnState } from './spawn-state'
import { noteRuntimePaneCreateResult, resolvePaneSpawnReservation } from '../pane/spawn-reservation'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

export function completeRuntimeSpawnResponse(ctx: RuntimePtySpawnState) {
  const args = ctx.args
  const response = {
    id: ctx.result.id,
    ...(ctx.result.incarnationId ? { incarnationId: ctx.result.incarnationId } : {}),
    ...(ctx.stablePaneOwner && (ctx.stablePaneOwner.handle || args.preAllocatedHandle)
      ? {
          stablePaneOwner: {
            handle: ctx.stablePaneOwner.handle ?? args.preAllocatedHandle!,
            tabId: ctx.stablePaneOwner.tabId,
            leafId: ctx.stablePaneOwner.leafId
          }
        }
      : {}),
    ...(ctx.result.agentSessionEnsure ? { agentSessionEnsure: ctx.result.agentSessionEnsure } : {})
  }
  const joined = {
    ...ctx.result,
    ...(typeof ctx.result.snapshotKittyKeyboardFlags === 'number' &&
    ctx.reconciledSnapshotSeq !== null &&
    ctx.snapshotKittyFlagsCoverReconciledSeq
      ? { snapshotSeq: ctx.reconciledSnapshotSeq }
      : { snapshotKittyKeyboardFlags: undefined }),
    isReattach: true as const
  }
  resolvePaneSpawnReservation(ctx.paneSpawnReservationKey, ctx.paneSpawnReservation, joined)
  // Switch point: a window view waiting on this create attaches to what it started.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    noteRuntimePaneCreateResult(ctx.paneSpawnReservationKey, joined)
  }
  return { ...ctx.result, ...response, wslDistro: ctx.result.wslDistro ?? undefined }
}
