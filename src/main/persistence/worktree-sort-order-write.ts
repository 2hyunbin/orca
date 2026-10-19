import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
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
    const hostId = parseExecutionHostId(hostIds?.[index])?.id
    targets.set(
      worktreeId,
      hostId
        ? hostWorktreeTarget({ id: worktreeId, hostId })
        : resolveWorktreeMetaOwner(store, worktreeId)
    )
  })
  const metaFor = (worktreeId: string): WorktreeMeta | undefined => {
    const target = targets.get(worktreeId)
    return target && store.getWorktreeMetaForHost
      ? store.getWorktreeMetaForHost(worktreeId, target.hostId)
      : store.getWorktreeMeta(worktreeId)
  }
  return planWorktreeSortOrderUpdates(request.orderedIds, metaFor, now).filter((update) => {
    const target = targets.get(update.worktreeId)
    if (!target || isBlocked(update.worktreeId)) {
      return false
    }
    store.setWorktreeMeta(target, { sortOrder: update.sortOrder })
    return true
  })
}
