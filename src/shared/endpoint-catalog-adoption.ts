// The host stamp a repo or host-setup row takes when it crosses from an endpoint into a client's
// all-host catalog. Shared so the paired phone files a server's rows under the host the desktop does.
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from './execution-host'
import { normalizeProjectHostSetupRow } from './project-catalog-row-normalization'
import type { ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'
import type { RuntimeClientTarget } from './runtime-client-target'

export function adoptEndpointRepo(target: RuntimeClientTarget, repo: Repo): Repo {
  if (target.kind === 'environment') {
    // `connectionId` survives: on a server's row it names that server's nested SSH target.
    return { ...repo, executionHostId: toRuntimeExecutionHostId(target.environmentId) }
  }
  if (repo.connectionId) {
    return { ...repo, executionHostId: getRepoExecutionHostId(repo) }
  }
  return repo.executionHostId ? repo : { ...repo, executionHostId: LOCAL_EXECUTION_HOST_ID }
}

export function adoptEndpointProjectHostSetup(
  target: RuntimeClientTarget,
  setup: ProjectHostSetup
): ProjectHostSetup {
  // Why here: every setup row crossing IPC or RPC into a client passes through this
  // adoption step, so it is where the declared field types stop being aspirational.
  const adopted = normalizeProjectHostSetupRow(setup)
  if (target.kind !== 'environment') {
    return adopted
  }
  const hostId = toRuntimeExecutionHostId(target.environmentId)
  const executionHostId = adopted.executionHostId ?? adopted.hostId
  return {
    ...adopted,
    hostId,
    executionHostId: executionHostId === LOCAL_EXECUTION_HOST_ID ? hostId : executionHostId,
    runtimeOwnerEnvironmentId: target.environmentId,
    // Why: paired clients route through the HUB and must not treat its private SSH target as client-local configuration.
    connectionId: null
  }
}
