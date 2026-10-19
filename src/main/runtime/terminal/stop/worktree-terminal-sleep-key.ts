import {
  getConnectionExecutionHostId,
  getRepoSshConnectionId,
  getWorktreeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
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

/** The host a spawn's `spawnWorktreeTarget` names: a `runtime:` stamp runs its nested SSH here. */
export function resolvedWorktreeSleepKey(
  worktree: Pick<Worktree, 'id' | 'hostId'>,
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined
): HostScopedWorktreeKey {
  const host = parseExecutionHostId(getWorktreeExecutionHostId(worktree, repo))
  const connectionId =
    host?.kind === 'ssh'
      ? host.targetId
      : host?.kind === 'runtime' && repo
        ? getRepoSshConnectionId(repo)
        : null
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
