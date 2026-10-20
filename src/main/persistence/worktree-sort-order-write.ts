import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import {
  hostWorktreeTarget,
  type HostWorktreeTarget
} from '../../shared/worktree/host-qualified-identity'
import {
  planWorktreeSortOrderUpdates,
  type WorktreeSortOrderUpdate
} from '../../shared/worktree/sort-order-update'
import { resolveWorktreeMetaOwner } from './host-qualified-worktree-meta'

export type WorktreeSortOrderRequest = {
  orderedIds: readonly string[]
  /** Parallel to `orderedIds`: the copy each id names. Older clients send none. */
  hostIds?: readonly string[]
}

type SortOrderStore = {
  getWorktreeMeta: (worktreeId: string) => WorktreeMeta | undefined
  getWorktreeMetaForHost?: (
    worktreeId: string,
    executionHostId: ExecutionHostId
  ) => WorktreeMeta | undefined
  getRepos: () => readonly Repo[]
  setWorktreeMeta: (target: HostWorktreeTarget, updates: Partial<WorktreeMeta>) => unknown
}

/**
 * The client's host for this id as this store spells it, or null when no repo row lives there.
 * The client names hosts relative to this endpoint, so its `local` is also a row this store
 * stamped with its own `runtime:` id.
 */
function knownHost(
  store: SortOrderStore,
  worktreeId: string,
  hostId: string | undefined
): ExecutionHostId | null {
  const parsed = parseExecutionHostId(hostId)
  if (!parsed) {
    return null
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const matches = new Set(
    store
      .getRepos()
      .filter((repo) => repo.id === repoId)
      .map(getRepoExecutionHostId)
      .filter(
        (stored) =>
          stored === parsed.id ||
          (parsed.kind === 'local' && parseExecutionHostId(stored)?.kind === 'runtime')
      )
  )
  const [only] = matches
  return matches.size === 1 && only ? only : null
}

/**
 * Saves an order onto the copies it names. An id the client did not qualify lands only when one
 * host owns it, so a same-id twin on another host keeps its own order.
 * @returns the updates actually written.
 */
export function writeWorktreeSortOrder(
  store: SortOrderStore,
  request: WorktreeSortOrderRequest,
  isBlocked: (worktreeId: string) => boolean,
  now: number
): WorktreeSortOrderUpdate[] {
  const hostIds =
    request.hostIds?.length === request.orderedIds.length ? request.hostIds : undefined
  const targets = new Map<string, HostWorktreeTarget | undefined>()
  request.orderedIds.forEach((worktreeId, index) => {
    if (targets.has(worktreeId)) {
      return
    }
    // Before any host-qualified read: that read migrates a legacy row the move must keep frozen.
    if (isBlocked(worktreeId)) {
      targets.set(worktreeId, undefined)
      return
    }
    if (!hostIds) {
      targets.set(worktreeId, resolveWorktreeMetaOwner(store, worktreeId))
      return
    }
    // A named host this store no longer registers is skipped, never redirected to another copy.
    const hostId = knownHost(store, worktreeId, hostIds[index])
    targets.set(worktreeId, hostId ? hostWorktreeTarget({ id: worktreeId, hostId }) : undefined)
  })
  const metaFor = (worktreeId: string): WorktreeMeta | undefined => {
    const target = targets.get(worktreeId)
    return target && store.getWorktreeMetaForHost
      ? store.getWorktreeMetaForHost(worktreeId, target.hostId)
      : store.getWorktreeMeta(worktreeId)
  }
  return planWorktreeSortOrderUpdates(request.orderedIds, metaFor, now).filter((update) => {
    const target = targets.get(update.worktreeId)
    if (!target) {
      return false
    }
    store.setWorktreeMeta(target, { sortOrder: update.sortOrder })
    return true
  })
}
