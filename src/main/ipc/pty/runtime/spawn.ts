import type { AgentSessionClaimedSpawnResult } from '../../../../shared/agent-session-host-authority'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import { rejectPaneSpawnReservation } from '../pane/spawn-reservation'
import { ptySizes } from '../delivery/visibility-state'
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

function toRuntimeSpawnReply(result: {
  id: string
  incarnationId?: string
  wslDistro?: string | null
  stablePaneOwner?: { handle: string; tabId: string; leafId: string }
  agentSessionEnsure?: AgentSessionClaimedSpawnResult
}) {
  return {
    id: result.id,
    ...(result.incarnationId ? { incarnationId: result.incarnationId } : {}),
    ...(typeof result.wslDistro === 'string' ? { wslDistro: result.wslDistro } : {}),
    ...(result.stablePaneOwner ? { stablePaneOwner: result.stablePaneOwner } : {}),
    ...(result.agentSessionEnsure ? { agentSessionEnsure: result.agentSessionEnsure } : {})
  }
}

function restoreProvisionalPtySize(ctx: ReturnType<typeof createRuntimePtySpawnState>): void {
  if (ctx.sessionId === undefined) {
    return
  }
  const key = ctx.effectiveSessionAppId ?? ctx.sessionId
  if (ctx.hadSessionSizeBeforeAttach && ctx.sessionSizeBeforeAttach) {
    ptySizes.set(key, ctx.sessionSizeBeforeAttach)
  } else {
    ptySizes.delete(key)
  }
}

export async function spawnPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  args: RuntimePtySpawnArgs
) {
  if (
    args.paneSpawnOperation ||
    !args.worktreeId ||
    !args.tabId ||
    !args.leafId ||
    !isValidTerminalTabId(args.tabId) ||
    !isTerminalLeafId(args.leafId)
  ) {
    return spawnFreshPtyFromRuntimeController(deps, args)
  }
  let freshResult: Awaited<ReturnType<typeof spawnFreshPtyFromRuntimeController>> | undefined
  const adopted = await deps.adoptStablePane({
    cols: args.cols,
    rows: args.rows,
    cwd: args.cwd,
    worktreeId: args.worktreeId,
    tabId: args.tabId,
    leafId: args.leafId,
    connectionId: args.connectionId,
    preAllocatedHandle: args.preAllocatedHandle,
    signal: args.signal,
    completed: args.adoptedStablePane,
    spawnFresh: async (operation) => {
      freshResult = await spawnFreshPtyFromRuntimeController(deps, {
        ...args,
        paneSpawnOperation: operation
      })
      return freshResult
    }
  })
  if (!adopted) {
    return toRuntimeSpawnReply(freshResult!)
  }
  const completed = await adoptMaterializedRuntimePtySpawn(
    createRuntimePtySpawnState(deps, { ...args, adoptedStablePane: adopted })
  )
  return toRuntimeSpawnReply(completed ?? adopted.result)
}

async function spawnFreshPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  args: RuntimePtySpawnArgs
) {
  const ctx = createRuntimePtySpawnState(deps, args)

  try {
    const materializedOrPromise = adoptMaterializedRuntimePtySpawn(ctx)
    const materialized =
      materializedOrPromise instanceof Promise ? await materializedOrPromise : materializedOrPromise
    if (materialized) {
      return toRuntimeSpawnReply(materialized)
    }
    const earlyAdopt = await prepareRuntimePtySpawn(ctx)
    if (earlyAdopt) {
      return toRuntimeSpawnReply(earlyAdopt)
    }
    const earlyReserved = await buildRuntimePtySpawnOptions(ctx).catch((error: unknown) => {
      restoreProvisionalPtySize(ctx)
      throw error
    })
    if (earlyReserved) {
      return toRuntimeSpawnReply(earlyReserved)
    }
    await executeRuntimePtySpawn(ctx)
    const committed = await commitRuntimePtySpawn(ctx)
    commitRuntimeSpawnHiddenDelivery(ctx)
    return committed
  } catch (err) {
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
