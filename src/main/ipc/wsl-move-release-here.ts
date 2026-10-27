/**
 * Bringing moved projects back to this computer: one project's move ("Use on this computer
 * again"), or a distro's whole chain (R38 Restore). Host copies stop first, then the moves are
 * dropped newest first, then the window reloads once to hydrate the pre-move session.
 */
import {
  WSL_MOVE_CUTOVER_PHASES,
  wslMoveJournalKey,
  type WslMoveCutover
} from '../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveUseLocallyResult } from '../../shared/wsl-move/wsl-moved-project'
import { listWslMoveCutoverChain } from '../persistence/moving-wsl-projects/wsl-move-cutover-journal'
import type { WslMoveProjectRef } from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { fenceHostSpawnsForWslMoveUndo } from '../persistence/moving-wsl-projects/wsl-move-undo-spawn-fence'
import {
  findWslMovedProjectMove,
  releaseWslMove,
  wslMoveReleaseRefusal,
  wslMoveWorkspacesInScope
} from '../persistence/moving-wsl-projects/wsl-move-use-locally'
import {
  holdWslMoveWindowWrites,
  reloadWslMoveWindowWithWritesHeld
} from '../persistence/moving-wsl-projects/wsl-move-window-write-hold'
import type { WslMoveUndoPorts } from './wsl-move-undo-wiring'

const COMMITTED_FROM = WSL_MOVE_CUTOVER_PHASES.indexOf('destination-committed')

const releasedByUserListeners = new Set<(distro: string) => void>()

/** Hears each "Use on this computer again" that released a move; Restore is not one. */
export function onWslMoveReleasedByUser(listener: (distro: string) => void): () => void {
  releasedByUserListeners.add(listener)
  return () => releasedByUserListeners.delete(listener)
}

/** "Use on this computer again" for one project: its whole move comes back and the window reloads. */
export async function releaseWslMovedProjectHere(
  userDataPath: string,
  ref: WslMoveProjectRef,
  unsavedWorkspaceIdsAsked: readonly string[],
  createUndoPorts: () => WslMoveUndoPorts
): Promise<WslMoveUseLocallyResult> {
  const found = findWslMovedProjectMove(userDataPath, ref)
  if (!('move' in found)) {
    return found
  }
  const result = await releaseWslMovesHere(
    userDataPath,
    [found.move],
    unsavedWorkspaceIdsAsked,
    createUndoPorts
  )
  if (result.released) {
    for (const listener of releasedByUserListeners) {
      listener(result.distro)
    }
  }
  return result
}

/** R38 Restore: every finished move of the distro comes back in one go, newest first. */
export async function releaseWslMoveChainHere(
  userDataPath: string,
  distro: string,
  unsavedWorkspaceIdsAsked: readonly string[],
  createUndoPorts: () => WslMoveUndoPorts
): Promise<WslMoveUseLocallyResult> {
  const moves = listWslMoveCutoverChain(userDataPath, wslMoveJournalKey(distro))
    .filter((move) => WSL_MOVE_CUTOVER_PHASES.indexOf(move.phase) >= COMMITTED_FROM)
    .toReversed()
  return moves.length > 0
    ? releaseWslMovesHere(userDataPath, moves, unsavedWorkspaceIdsAsked, createUndoPorts)
    : { released: false, reason: 'not-moved' }
}

async function releaseWslMovesHere(
  userDataPath: string,
  newestFirst: readonly WslMoveCutover[],
  unsavedWorkspaceIdsAsked: readonly string[],
  createUndoPorts: () => WslMoveUndoPorts
): Promise<WslMoveUseLocallyResult> {
  // Only the moves' own workspaces reload from their pre-move state; other unsaved files stay.
  const unsavedWorkspaceIds = [
    ...new Set(
      newestFirst.flatMap((move) => wslMoveWorkspacesInScope(move, unsavedWorkspaceIdsAsked))
    )
  ]
  if (unsavedWorkspaceIds.length > 0) {
    return { released: false, reason: 'unsaved-files', unsavedWorkspaceIds }
  }
  const first = newestFirst[0]
  // Why before the stop: a refused undo must leave the host's copies running (X1).
  const refusal = wslMoveReleaseRefusal(userDataPath, first)
  if (refusal) {
    return refusal
  }
  // Fenced until the reload: an open host pane would otherwise start its stopped agent again.
  const releaseSpawnFence = fenceHostSpawnsForWslMoveUndo(first.destinationEnvironmentId)
  let fenceHandedToReload = false
  try {
    const repoIds: string[] = []
    const folderWorkspaceIds: string[] = []
    const released: WslMoveCutover[] = []
    let failure: Extract<WslMoveUseLocallyResult, { released: false }> | null = null
    for (const move of newestFirst) {
      const moveRefusal = move === first ? null : wslMoveReleaseRefusal(userDataPath, move)
      if (moveRefusal) {
        failure = moveRefusal
        break
      }
      const ports = createUndoPorts()
      // Automations first, as they undo cleanly: a refusal must leave the host's terminals running (X1).
      const automations = (await ports.stopHostAutomations?.(move)) ?? {
        outcome: 'stopped',
        restore: async () => {},
        applyHere: () => {}
      }
      if (automations.outcome !== 'stopped') {
        failure = {
          released: false,
          reason: automations.outcome === 'unreachable' ? 'host-unreachable' : 'failed',
          detail:
            automations.outcome === 'removal-pending' ? 'host-removal-pending' : 'host-automations'
        }
        break
      }
      // The host's copies stop next, or an agent the move resumed there runs beside this one.
      const stop = await ports.stopHostCopies(move).catch(() => 'unreachable' as const)
      const release: WslMoveUseLocallyResult | null =
        stop === 'stopped' ? releaseWslMove(userDataPath, move) : null
      if (!release?.released) {
        // Refused after the automations went off: this attempt turns them back on.
        await automations.restore()
        failure = release ?? {
          released: false,
          reason: stop === 'unreachable' ? 'host-unreachable' : 'host-still-running'
        }
        break
      }
      // Part of the release, so a refused undo changes nothing here.
      try {
        automations.applyHere()
      } catch (error) {
        console.warn('[wsl-move] Could not give the automations here their host state:', error)
      }
      released.push(move)
      repoIds.push(...release.repoIds)
      folderWorkspaceIds.push(...release.folderWorkspaceIds)
    }
    if (repoIds.length === 0 && folderWorkspaceIds.length === 0) {
      return failure ?? { released: false, reason: 'not-moved' }
    }
    // Released moves stay released even if an older one refused; the reload shows what came back.
    holdWslMoveWindowWrites()
    // Focus left on a host copy would reopen its panes after the reload and restart their agents.
    const ports = createUndoPorts()
    for (const move of released) {
      ports.refocusHere?.(move)
    }
    fenceHandedToReload = true
    reloadWslMoveWindowWithWritesHeld(releaseSpawnFence)
    return (
      failure ?? {
        released: true,
        distro: first.manifest.source.distro,
        repoIds,
        folderWorkspaceIds
      }
    )
  } finally {
    // Any refusal, or a throw, before the reload took the fence over releases it here.
    if (!fenceHandedToReload) {
      releaseSpawnFence()
    }
  }
}
