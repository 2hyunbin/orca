import {
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost,
  LOCAL_EXECUTION_HOST_ID,
  normalizeHostPart,
  type ExecutionHostId
} from '../shared/execution-host'
import type { Repo } from '../shared/repo-types'
import { requireReachableGitRoute } from './providers/execution-host-provider-dispatch'
import { SshHostNotServedError } from './providers/ssh-host-not-served-error'

/** Only for rows from this process's Store: runtime stamps address files registered here. */
export function getStoredRepoExecutionHostId(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): ExecutionHostId {
  const hostId = getRepoExecutionHostId(repo)
  return getSshTargetIdForExecutionHost(hostId) ? hostId : LOCAL_EXECUTION_HOST_ID
}

export function getStoredRepoSshConnectionId(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): string | null {
  return getSshTargetIdForExecutionHost(getStoredRepoExecutionHostId(repo))
}

/**
 * The gate for Git this process runs on a repo row's checkout. `ssh:` and `runtime:` rows throw, as
 * does a `local` row still carrying a `connectionId`: it contradicts itself, so it never runs here.
 */
export function requireRepoLocalGitRoute(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): ReturnType<typeof requireReachableGitRoute> {
  const route = requireReachableGitRoute(getRepoExecutionHostId(repo))
  const staleConnectionId = normalizeHostPart(repo.connectionId)
  if (staleConnectionId) {
    throw new SshHostNotServedError(staleConnectionId)
  }
  return route
}
