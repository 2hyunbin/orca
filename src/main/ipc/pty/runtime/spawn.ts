import {
  captureSavedResumeCleanup,
  admitColdRestoreReattach,
  savedResumeRecord,
  savedResumeResult,
  resumeSpawnRefusal,
  forgetRefusedResume,
  settleSwitchSpawn
} from '../host-env/saved-resume-admission'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import {
  makePaneSpawnReservationKey,
  paneSpawnReservationsByOwnerKey,
  rejectPaneSpawnReservation,
  reservePaneSpawn
} from '../pane/spawn-reservation'
import { resolveStablePaneOwner } from '../pane/stable-owner'
import { restoreProvisionalPtySize } from '../spawn-options-assembly'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { adoptMaterializedRuntimePtySpawn } from './spawn-early'
import { prepareRuntimePtySpawn } from './spawn-preflight'
import { buildRuntimePtySpawnOptions } from './spawn-options'
import { executeRuntimePtySpawn } from './spawn-execute'
import { commitRuntimePtySpawn } from './spawn-commit'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'
import {
  commitRuntimeSpawnHiddenDelivery,
  releaseRuntimeSpawnPreSpawnHiddenMark
} from './spawn-hidden-delivery'

export async function spawnPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  args: RuntimePtySpawnArgs
) {
  const ctx = createRuntimePtySpawnState(deps, args)
  if (!args.adoptedStablePane) {
    const leafId =
      typeof args.leafId === 'string' && isTerminalLeafId(args.leafId) ? args.leafId : null
    const paneKey =
      typeof args.worktreeId === 'string' &&
      typeof args.tabId === 'string' &&
      isValidTerminalTabId(args.tabId) &&
      args.tabId.length <= 512 &&
      leafId
        ? makePaneKey(args.tabId, leafId)
        : null
    const ownerKey = makePaneSpawnReservationKey(args.worktreeId, args.connectionId, paneKey)
    const existingOwner = paneKey
      ? resolveStablePaneOwner(
          deps.runtime,
          deps.store,
          paneKey,
          args.worktreeId,
          args.connectionId
        )
      : null
    if (ownerKey && !existingOwner && !paneSpawnReservationsByOwnerKey.has(ownerKey)) {
      ctx.paneSpawnReservationKey = ownerKey
      ctx.paneSpawnReservation = reservePaneSpawn(ownerKey)
    }
  }
  try {
    const materializedOrPromise = adoptMaterializedRuntimePtySpawn(ctx)
    const materialized =
      materializedOrPromise instanceof Promise ? await materializedOrPromise : materializedOrPromise
    if (materialized) {
      return { ...materialized, ...deps.runtime?.getTerminalLaunchResult?.(materialized.id) }
    }
    const earlyAdopt = await prepareRuntimePtySpawn(ctx)
    if (earlyAdopt) {
      return { ...earlyAdopt, ...deps.runtime?.getTerminalLaunchResult?.(earlyAdopt.id) }
    }
    const earlyReserved = await buildRuntimePtySpawnOptions(ctx).catch((error: unknown) => {
      restoreProvisionalPtySize({
        sessionId: ctx.sessionId,
        sessionAppId: ctx.effectiveSessionAppId,
        hadSessionSizeBeforeAttach: ctx.hadSessionSizeBeforeAttach,
        sessionSizeBeforeAttach: ctx.sessionSizeBeforeAttach
      })
      throw error
    })
    if (earlyReserved) {
      return { ...earlyReserved, ...deps.runtime?.getTerminalLaunchResult?.(earlyReserved.id) }
    }
    await executeRuntimePtySpawn(ctx)
    if (!ctx.resumeAdmission) {
      ctx.resumeAdmission = await admitColdRestoreReattach(
        deps.runtime,
        ctx.result,
        {
          paneKey: ctx.spawnIdentityPaneKey,
          saved: savedResumeRecord(deps.store, ctx.spawnIdentityPaneKey)
        },
        ctx.expectedWslDistro
      )
      await captureSavedResumeCleanup(
        deps.runtime,
        deps.store,
        ctx.spawnIdentityPaneKey,
        ctx.resumeAdmission,
        args.worktreeId
      )
    }
    if (!ctx.result.isReattach) {
      Object.assign(ctx.result, savedResumeResult(ctx.resumeAdmission), {
        ...(ctx.agentResumeUnavailable ? { agentResumeUnavailable: true as const } : {}),
        launchConfig: args.launchConfig,
        launchAgent: args.launchAgent,
        launchToken: args.launchToken,
        resumeProviderSession: ctx.codexResumeArgvDropped ? undefined : args.resumeProviderSession
      })
    }
    const committed = await commitRuntimePtySpawn(ctx)
    const refusal = resumeSpawnRefusal(ctx.resumeAdmission)
    forgetRefusedResume(ctx.spawnIdentityPaneKey, refusal)
    if (
      args.worktreeId &&
      ctx.spawnIdentityPaneKey &&
      refusal &&
      refusal.verdict !== 'unverifiable'
    ) {
      void deps.runtime
        ?.forgetRefusedSavedResume?.(
          args.worktreeId,
          ctx.spawnIdentityPaneKey,
          refusal.refused,
          refusal.sourceRecord
        )
        .catch((error: unknown) => console.warn('[pty] refused resume cleanup failed', error))
    }
    commitRuntimeSpawnHiddenDelivery(ctx)
    if (!ctx.result.isReattach) {
      deps.runtime?.rememberSavedTerminalLaunchResult?.(committed.id, committed)
    }
    settleSwitchSpawn(deps.runtime, ctx.switchAttempt, { ptyId: committed.id })
    return committed
  } catch (err) {
    settleSwitchSpawn(deps.runtime, ctx.switchAttempt, {
      // A daemon session may exist even with no reply; an in-process spawn that returned none made none.
      unknown: ctx.result.id || ctx.effectiveSessionAppId
    })
    releaseRuntimeSpawnPreSpawnHiddenMark(ctx)
    if (ctx.pendingRegistrationPtyId) {
      deps.runtime?.cancelPendingPtyRegistration?.(
        ctx.pendingRegistrationPtyId,
        ctx.rejectedRegistrationCandidate?.incarnationId
      )
      ctx.pendingRegistrationPtyId = null
    }
    // Why: once the reservation is created, any later throw — spawn
    // failure, persist failure, or a post-spawn helper such as
    // registerPty/rememberPaneKeyForPty/track — must settle it. Otherwise
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
