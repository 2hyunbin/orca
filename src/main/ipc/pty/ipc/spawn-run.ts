import { rejectPaneSpawnReservation, reserveIdlePaneSpawn } from '../pane/spawn-reservation'
import { restoreProvisionalPtySize } from '../spawn-options-assembly'
import {
  beginPtyIpcSpawn,
  resolveEarlyPaneKey,
  resolveEarlyPaneSpawnReservationKey
} from './spawn-begin'
import { releaseStoppedPaneBinding, stopReplacedPaneOwner } from '../pane/pane-owner-replacement'
import { planPaneAgentLaunch } from './spawn-agent-launch'
import { endPaneAgentLaunch } from './spawn-agent-launch-end'
import { preparePtyIpcSpawnPreflight } from './spawn-preflight'
import { assemblePtyIpcSpawnEnv } from './spawn-env'
import { preparePtyIpcQoderCommand } from './spawn-qoder-command'
import { buildPtyIpcSpawnOptions } from './spawn-options'
import { executePtyIpcSpawn } from './spawn-execute'
import { commitPtyIpcSpawn } from './spawn-commit'
import { createPtyIpcSpawnState, type PtyIpcSpawnState } from './spawn-state'
import { triggerPtySpawnPushTargetMaterialization } from './spawn-push-target-materialization'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { refuseClosedPaneSpawn } from './closed-pane-spawn-refusal'
import {
  captureSavedResumeCleanup,
  admitColdRestoreReattach,
  forgetRefusedResume,
  settleSwitchSpawn,
  resumeSpawnRefusal,
  savedResumeRecord
} from '../host-env/saved-resume-admission'

function releaseAbandonedAgentTeamsLeader(ctx: PtyIpcSpawnState): void {
  if (!ctx.agentTeamsLeaderHandle) {
    return
  }
  ctx.deps.runtime?.releaseClaudeAgentTeamsLeaderForHandle?.(ctx.agentTeamsLeaderHandle)
  ctx.agentTeamsLeaderHandle = null
}

export async function runPtyIpcSpawn(deps: PtySpawnIpcDeps, args: PtySpawnIpcArgs) {
  const ctx = createPtyIpcSpawnState(deps, args)
  const replacedPaneKey =
    args.replacesPtyId !== undefined ? resolveEarlyPaneSpawnReservationKey(args) : null
  if (replacedPaneKey) {
    // Why: hold the pane across the stop, so a spawn for it arriving meanwhile (a hidden tab
    // revealed mid-restart) joins the replacement instead of reattaching the owner being stopped.
    ctx.paneSpawnReservation = await reserveIdlePaneSpawn(replacedPaneKey)
    ctx.paneSpawnReservationKey = replacedPaneKey
  }
  try {
    if (args.replacesPtyId !== undefined) {
      ctx.replacedPaneOwner = await stopReplacedPaneOwner(deps, {
        replacesPtyId: args.replacesPtyId,
        paneKey: resolveEarlyPaneKey(args),
        worktreeId: args.worktreeId,
        connectionId: args.connectionId
      })
    }
    triggerPtySpawnPushTargetMaterialization(deps, args)
    const early = await beginPtyIpcSpawn(ctx)
    if (early) {
      return { ...early, ...deps.runtime?.getTerminalLaunchResult?.(early.id) }
    }
    // Awaited only for a launch: an ordinary spawn reaches its provider in the same turn as before.
    if (ctx.args.agentLaunch !== undefined) {
      await planPaneAgentLaunch(ctx)
    }
    await preparePtyIpcSpawnPreflight(ctx)
    await assemblePtyIpcSpawnEnv(ctx)
    await preparePtyIpcQoderCommand(ctx)
    const earlyReserved = await buildPtyIpcSpawnOptions(ctx).catch((error: unknown) => {
      restoreProvisionalPtySize({
        sessionId: ctx.effectiveSessionId,
        sessionAppId: ctx.effectiveSessionAppId,
        hadSessionSizeBeforeAttach: ctx.hadSessionSizeBeforeAttach,
        sessionSizeBeforeAttach: ctx.sessionSizeBeforeAttach
      })
      throw error
    })
    if (earlyReserved) {
      // Why: this request lost the pane to the reservation winner, so its
      // pre-allocated leader handle never binds to a PTY. Nothing else can
      // evict the team env assembly created for it — exit/close cleanup keys
      // off handleByPtyId — so every lost race would leak one team forever.
      releaseAbandonedAgentTeamsLeader(ctx)
      return { ...earlyReserved, ...deps.runtime?.getTerminalLaunchResult?.(earlyReserved.id) }
    }
    // Right before the provider spawn, with nothing awaited in between: a closed pane starts nothing.
    ctx.paneAgentLaunch?.refuseIfClosed()
    // Switch point: a pane main closed or took back while this spawn waited starts nothing.
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      refuseClosedPaneSpawn(deps.store, args.tabId, args.leafId)
    }
    await executePtyIpcSpawn(ctx)
    if (!ctx.resumeAdmission) {
      ctx.resumeAdmission = await admitColdRestoreReattach(
        deps.runtime,
        ctx.result,
        { paneKey: ctx.stablePaneKey, saved: savedResumeRecord(deps.store, ctx.stablePaneKey) },
        ctx.expectedWslDistro
      )
      await captureSavedResumeCleanup(
        deps.runtime,
        deps.store,
        ctx.stablePaneKey,
        ctx.resumeAdmission,
        args.worktreeId
      )
    }
    const committed = await commitPtyIpcSpawn(ctx)
    const refusal = resumeSpawnRefusal(ctx.resumeAdmission)
    forgetRefusedResume(ctx.stablePaneKey, refusal)
    if (args.worktreeId && ctx.stablePaneKey && refusal && refusal.verdict !== 'unverifiable') {
      void deps.runtime
        ?.forgetRefusedSavedResume?.(
          args.worktreeId,
          ctx.stablePaneKey,
          refusal.refused,
          refusal.sourceRecord
        )
        .catch((error: unknown) => console.warn('[pty] refused resume cleanup failed', error))
    }
    endPaneAgentLaunch(
      ctx,
      ctx.exitedBeforeRegistration ? { exitedDuringStart: true } : { started: true }
    )
    if (!ctx.result.isReattach) {
      deps.runtime?.rememberSavedTerminalLaunchResult?.(committed.id, committed)
    }
    settleSwitchSpawn(deps.runtime, ctx.resumeAdmission, committed.id)
    return committed
  } catch (caught) {
    settleSwitchSpawn(deps.runtime, ctx.resumeAdmission, ctx.result.id)
    const err = endPaneAgentLaunch(ctx, { error: caught }) ?? caught
    releaseAbandonedAgentTeamsLeader(ctx)
    if (ctx.preSpawnHiddenMarkId !== null) {
      ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState(ctx.preSpawnHiddenMarkId, false)
    }
    if (ctx.pendingRegistrationPtyId) {
      deps.runtime?.cancelPendingPtyRegistration?.(
        ctx.pendingRegistrationPtyId,
        ctx.rejectedRegistrationCandidate?.incarnationId
      )
      ctx.pendingRegistrationPtyId = null
    }
    if (ctx.replacedPaneOwner) {
      await releaseStoppedPaneBinding(deps.store, ctx.replacedPaneOwner)
    }
    // Why: once the reservation is created, any later throw —
    // spawn failure, persist failure, or a post-spawn helper such as
    // seedHeadlessTerminal/registerPty/track — must settle it. Otherwise
    // it lingers in paneSpawnReservationsByOwnerKey and every future spawn
    // for this pane awaits a promise that never resolves. reject is a
    // no-op once the reservation has already resolved.
    rejectPaneSpawnReservation(ctx.paneSpawnReservationKey, ctx.paneSpawnReservation, err)
    throw err
  } finally {
    ctx.releaseWorktreeSpawn?.()
    ctx.finishTerminalInstall()
  }
}
