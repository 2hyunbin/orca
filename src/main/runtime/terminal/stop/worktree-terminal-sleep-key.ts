import type { ExecutionHostId } from '../../../../shared/execution-host'
import { worktreeIdentityKey } from '../../../../shared/worktree/id'
import {
  composeWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  type HostScopedWorktreeKey
} from '../../../../shared/worktree/host-qualified-identity'

/**
 * Keys a worktree's sleep by the host its terminals run on: a same-id SSH twin is another
 * workspace, so its spawn must neither wake nor be refused by this copy's sleep.
 */
export function hostWorktreeSleepKey(
  hostId: ExecutionHostId,
  worktreeId: string
): HostScopedWorktreeKey {
  return composeWorktreeHostIdentity(hostId, worktreeIdentityKey(worktreeId))
}

/** Host-blind match, for readers that only know the bare workspace id. */
export function sleepKeysNameWorktree(keys: Iterable<string>, worktreeId: string): boolean {
  const wanted = worktreeIdentityKey(worktreeId)
  for (const key of keys) {
    if (getWorktreeIdFromHostIdentity(key) === wanted) {
      return true
    }
  }
  return false
}
