import {
  getConnectionExecutionHostId,
  getSshTargetIdForExecutionHost,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { resolveWorktreeLaunchHost, type LaunchHostRepo } from '../../worktree-launch-host-repo'
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

/**
 * The host this process launches the worktree's terminals on, from the same resolver the launch
 * scope uses, so a spawn's `spawnWorktreeTarget` names the same key. Rival rows that disagree
 * leave the launch refused; the worktree's own host stamp is the only answer then.
 */
export function resolvedWorktreeSleepKey(
  repos: readonly LaunchHostRepo[],
  worktree: { id: string; repoId: string; hostId?: string | null }
): HostScopedWorktreeKey {
  const launch = resolveWorktreeLaunchHost(repos, worktree)
  const connectionId =
    launch.kind === 'resolved'
      ? launch.connectionId
      : getSshTargetIdForExecutionHost(worktree.hostId)
  return hostWorktreeSleepKey(getConnectionExecutionHostId(connectionId), worktree.id)
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
