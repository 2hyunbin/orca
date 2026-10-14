import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import type { HostProjectCatalog } from '../../../src/shared/all-host-project-catalog'
import {
  adoptEndpointProjectCatalog,
  adoptEndpointRepo
} from '../../../src/shared/endpoint-catalog-adoption'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import type { RuntimeClientTarget } from '../../../src/shared/runtime-client-target'
import type { RpcResponse } from '../transport/types'
import type { RpcAcceptedResult } from '../transport/rpc-accepted-result'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { isMobileMethodUnavailableError } from '../transport/mobile-method-unavailable'
import {
  projectCatalogProjectListRead,
  projectCatalogRepoListRead,
  projectCatalogSetupListRead
} from './project-catalog-operations'

/** The paired desktop's own catalog (its local and SSH repos), filed as its renderer files it. */
export const DESKTOP_PROJECT_CATALOG_HOST_ID: ExecutionHostId = LOCAL_EXECUTION_HOST_ID

function endpointTarget(hostId: ExecutionHostId): RuntimeClientTarget {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'runtime'
    ? { kind: 'environment', environmentId: parsed.environmentId }
    : { kind: 'local' }
}

type ListRead<Value> =
  | { kind: 'answered'; value: Value }
  | { kind: 'unavailable' }
  | { kind: 'failed' }

async function readList<Value>(
  send: () => Promise<RpcResponse>,
  interpret: (reply: RpcResponse) => RpcAcceptedResult<Value>
): Promise<ListRead<Value>> {
  try {
    const reply = await send()
    if (!reply.ok) {
      return isMobileMethodUnavailableError(reply.error.code, reply.error.message)
        ? { kind: 'unavailable' }
        : { kind: 'failed' }
    }
    const verdict = interpret(reply)
    return verdict.accepted ? { kind: 'answered', value: verdict.value } : { kind: 'failed' }
  } catch {
    return { kind: 'failed' }
  }
}

/**
 * One host's catalog: the desktop's own through `client`, or a server's through a client scoped to
 * it. Null when it did not answer this round, so the caller keeps that host's last catalog.
 */
export async function fetchHostProjectCatalog(
  client: RpcOperationSender,
  hostId: ExecutionHostId
): Promise<HostProjectCatalog | null> {
  const target = endpointTarget(hostId)
  const [repos, projects, setups] = await Promise.all([
    readList(
      () => projectCatalogRepoListRead.request(client),
      projectCatalogRepoListRead.interpret
    ),
    readList(
      () => projectCatalogProjectListRead.request(client),
      projectCatalogProjectListRead.interpret
    ),
    readList(
      () => projectCatalogSetupListRead.request(client),
      projectCatalogSetupListRead.interpret
    )
  ])
  if (repos.kind !== 'answered') {
    return null
  }
  const adoptedRepos = repos.value.map((repo) => adoptEndpointRepo(target, repo))
  if (projects.kind === 'answered' && setups.kind === 'answered') {
    return {
      hostId,
      repos: adoptedRepos,
      projection: adoptEndpointProjectCatalog(target, projects.value, setups.value)
    }
  }
  // Why: only a host that predates the lists gets the repo-derived projection (the desktop
  // renderer's fallback); a transient failure must not regroup the list on a guess.
  if (projects.kind !== 'failed' && setups.kind !== 'failed') {
    return {
      hostId,
      repos: adoptedRepos,
      projection: projectHostSetupProjectionFromRepos(adoptedRepos)
    }
  }
  return null
}
