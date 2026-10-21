import type { RuntimePtySpawnState } from './spawn-state'
import { noteRuntimePaneCreateResult, resolvePaneSpawnReservation } from '../pane/spawn-reservation'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { PaneResumeOutcome } from '../../../../shared/workspace-layout/workspace-layout-published'

/** Whether a fresh start resumed the agent it was asked to; a reattach ran no launch command. */
function resumeOutcomeOf(ctx: RuntimePtySpawnState): PaneResumeOutcome | null {
  if (!ctx.args.resumeProviderSession || ctx.result.isReattach) {
    return null
  }
  if (ctx.codexResumeUnavailable) {
    return 'resume-unavailable'
  }
  // A resume dropped silently named another agent's session: nothing came back, and nothing is owed.
  return ctx.codexResumeArgvDropped ? null : 'restored'
}

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
  // Switch point: main's own start publishes whether it resumed the pane's agent.
  const resumeOutcome = ORCA_LAYOUT_OWNER_IS_MAIN ? resumeOutcomeOf(ctx) : null
  return {
    ...ctx.result,
    ...response,
    wslDistro: ctx.result.wslDistro ?? undefined,
    ...(resumeOutcome ? { resumeOutcome } : {})
  }
}
