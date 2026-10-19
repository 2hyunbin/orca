import type {
  Project,
  ProjectHostSetup,
  ProjectHostSetupExistingFolderArgs
} from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  projectHostSetupProjectionFromRepos,
  type ProjectHostSetupProjection
} from '../../../../shared/project-host-setup-projection'
import {
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc
} from '../../runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { adoptEndpointProjectCatalog } from '../../../../shared/endpoint-catalog-adoption'
import {
  getProjectHostSetupExecutionHostId,
  type ProjectHostSetupTarget
} from '../../../../shared/project-host-setup-target'

export function getProjectSetupRuntimeTarget(
  hostId: ProjectHostSetupExistingFolderArgs['hostId']
): RuntimeClientTarget {
  const parsedHost = parseExecutionHostId(hostId)
  return parsedHost?.kind === 'runtime'
    ? { kind: 'environment', environmentId: parsedHost.environmentId }
    : { kind: 'local' }
}

async function assertProjectHostSetupRuntimeCapability(target: RuntimeClientTarget): Promise<void> {
  if (target.kind !== 'environment') {
    return
  }
  await assertRuntimeEnvironmentCapability(
    target.environmentId,
    PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
    'The selected Orca server does not support project host setup yet. Update Orca on the server and try again.',
    15_000
  )
}

export async function fetchProjectHostSetupCompatibility(
  target: RuntimeClientTarget,
  repos: readonly Repo[]
): Promise<ProjectHostSetupProjection> {
  try {
    if (target.kind === 'local') {
      const projectsApi = (
        window.api as typeof window.api & {
          projects?: {
            list?: () => Promise<Project[]>
            listHostSetups?: () => Promise<ProjectHostSetup[]>
          }
        }
      ).projects
      if (!projectsApi?.list || !projectsApi.listHostSetups) {
        throw new Error('projects_api_unavailable')
      }
      return adoptEndpointProjectCatalog(
        target,
        await projectsApi.list(),
        await projectsApi.listHostSetups()
      )
    }
    await assertProjectHostSetupRuntimeCapability(target)
    const [projectResponse, setupResponse] = await Promise.all([
      callRuntimeRpc<{ projects: Project[] }>(target, 'project.list', undefined, {
        timeoutMs: 15_000
      }),
      callRuntimeRpc<{ setups: ProjectHostSetup[] }>(target, 'projectHostSetup.list', undefined, {
        timeoutMs: 15_000
      })
    ])
    return adoptEndpointProjectCatalog(target, projectResponse.projects, setupResponse.setups)
  } catch {
    // Why: newer clients must hydrate against older runtimes that only know repo.list; derive the transitional model locally.
    return projectHostSetupProjectionFromRepos(repos)
  }
}

export async function assertProjectHostSetupMutationRuntimeCapabilities(
  target: RuntimeClientTarget
): Promise<void> {
  if (target.kind !== 'environment') {
    return
  }
  await assertProjectHostSetupRuntimeCapability(target)
  await assertRuntimeEnvironmentCapability(
    target.environmentId,
    WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY,
    'The selected Orca server does not support explicit workspace run hosts yet. Update Orca on the server and try again.',
    15_000
  )
}

// Why: twins share `id`; a paired server's setups also share its `runtime:` hostId.
export function isSameProjectHostSetup(a: ProjectHostSetup, b: ProjectHostSetup): boolean {
  return (
    a.id === b.id &&
    a.hostId === b.hostId &&
    getProjectHostSetupExecutionHostId(a) === getProjectHostSetupExecutionHostId(b)
  )
}

export function upsertProjectHostSetup(
  setups: readonly ProjectHostSetup[],
  setup: ProjectHostSetup
): ProjectHostSetup[] {
  return setups.some((entry) => isSameProjectHostSetup(entry, setup))
    ? setups.map((entry) => (isSameProjectHostSetup(entry, setup) ? setup : entry))
    : [...setups, setup]
}

/**
 * Where a setup edit or removal goes, with the host that runs the setup named on the wire.
 * A caller's `hostId` is that execution host: the only field telling a server's twins apart.
 */
export function routeProjectHostSetupMutation<T extends ProjectHostSetupTarget>(
  setups: readonly ProjectHostSetup[],
  args: T
): { target: RuntimeClientTarget; hostArgs: T } {
  const setup = setups.find(
    (entry) =>
      entry.id === args.setupId &&
      (args.hostId === undefined || getProjectHostSetupExecutionHostId(entry) === args.hostId)
  )
  return setup
    ? {
        target: getProjectSetupRuntimeTarget(setup.hostId),
        hostArgs: { ...args, hostId: getProjectHostSetupExecutionHostId(setup) }
      }
    : { target: { kind: 'local' }, hostArgs: args }
}
