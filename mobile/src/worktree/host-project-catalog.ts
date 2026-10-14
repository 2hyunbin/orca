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

async function acceptedOrNull<Value>(
  send: () => Promise<RpcResponse>,
  interpret: (reply: RpcResponse) => RpcAcceptedResult<Value>
): Promise<Value | null> {
  try {
    const verdict = interpret(await send())
    return verdict.accepted ? verdict.value : null
  } catch {
    return null
  }
}

/**
 * One host's catalog: the desktop's own through `client`, or a server's through a client scoped to
 * it. Null when its repos did not answer, so the caller keeps what it had, as the desktop does.
 */
export async function fetchHostProjectCatalog(
  client: RpcOperationSender,
  hostId: ExecutionHostId
): Promise<HostProjectCatalog | null> {
  const target = endpointTarget(hostId)
  const [repos, projects, setups] = await Promise.all([
    acceptedOrNull(
      () => projectCatalogRepoListRead.request(client),
      projectCatalogRepoListRead.interpret
    ),
    acceptedOrNull(
      () => projectCatalogProjectListRead.request(client),
      projectCatalogProjectListRead.interpret
    ),
    acceptedOrNull(
      () => projectCatalogSetupListRead.request(client),
      projectCatalogSetupListRead.interpret
    )
  ])
  if (!repos) {
    return null
  }
  const adoptedRepos = repos.map((repo) => adoptEndpointRepo(target, repo))
  return {
    hostId,
    repos: adoptedRepos,
    // Why: a desktop or server that predates either list (forbidden or method_not_found) gets the
    // repo-derived projection, exactly the desktop renderer's fallback for such a host.
    projection:
      projects && setups
        ? adoptEndpointProjectCatalog(target, projects, setups)
        : projectHostSetupProjectionFromRepos(adoptedRepos)
  }
}
