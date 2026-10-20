import { z } from 'zod'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import { getWslHostService } from './wsl-host-service-instance'
import type { RpcCallerIdentity } from '../runtime/rpc/rpc-caller-identity'

type WslProjectOperation =
  | { kind: 'add'; path: string; repoKind?: 'git' | 'folder'; displayName?: string }
  | { kind: 'create'; path: string; name: string; repoKind: 'git' | 'folder' }

export function isPairedWslRoutingCaller(caller: RpcCallerIdentity | undefined): boolean {
  return caller?.kind !== 'local-cli' && caller?.kind !== 'desktop'
}

const ProjectReply = z.object({
  repo: z
    .object({
      id: z.string(),
      path: z.string(),
      displayName: z.string(),
      badgeColor: z.string(),
      addedAt: z.number(),
      kind: z.enum(['git', 'folder']).optional()
    })
    .passthrough()
})

const OwnerRepos = z.object({ repos: z.array(ProjectReply.shape.repo) })
const OwnerSetups = z.object({
  setups: z.array(
    z.object({
      projectId: z.string(),
      repoId: z.string(),
      path: z.string(),
      hostId: z.string(),
      setupMethod: z.enum(['legacy-repo', 'imported-existing-folder', 'cloned', 'provisioned'])
    })
  )
})
const OwnerProjects = z.object({ projects: z.array(z.object({ id: z.string() })) })

export async function listWslOwnerRepos(environmentId: string): Promise<Repo[]> {
  return OwnerRepos.parse(await callWslProjectHost(environmentId, 'repo.list', undefined)).repos
}

/** Existing owner operations also prepare metadata/root on guests whose update was deferred. */
export async function registerOnWslOwner(
  environmentId: string,
  operation: WslProjectOperation
): Promise<Repo> {
  const known = await listWslOwnerRepos(environmentId)
  const response = await callWslProjectHost(
    environmentId,
    `repo.${operation.kind}`,
    operation.kind === 'add'
      ? { path: operation.path, kind: operation.repoKind, displayName: operation.displayName }
      : { parentPath: operation.path, name: operation.name, kind: operation.repoKind }
  )
  if (typeof response === 'object' && response && 'error' in response) {
    throw new Error(String(response.error))
  }
  let repo: Repo = ProjectReply.parse(response).repo
  if (operation.repoKind !== 'folder' && !known.some((row) => row.id === repo.id)) {
    const { setups } = OwnerSetups.parse(
      await callWslProjectHost(environmentId, 'projectHostSetup.list', undefined)
    )
    const setup = setups.find(
      (row) =>
        row.repoId === repo.id &&
        row.path === repo.path &&
        row.hostId === getRepoExecutionHostId(repo)
    )
    const { projects } = OwnerProjects.parse(
      await callWslProjectHost(environmentId, 'project.list', undefined)
    )
    if (!setup || !projects.some((project) => project.id === setup.projectId)) {
      throw new Error('The project was added, but its host setup could not be prepared.')
    }
    // A concurrent explicit registration owns its provenance, even if our earlier snapshot missed it.
    if (setup.setupMethod === 'legacy-repo' && repo.projectHostSetupMethod == null) {
      const result = await callWslProjectHost(
        environmentId,
        'projectHostSetup.setupExistingFolder',
        {
          projectId: setup.projectId,
          hostId: LOCAL_EXECUTION_HOST_ID,
          path: repo.path,
          kind: 'git',
          setupMethod: 'imported-existing-folder'
        }
      )
      repo = z.object({ result: ProjectReply }).parse(result).result.repo
    }
  }
  return { ...repo, executionHostId: toRuntimeExecutionHostId(environmentId) }
}

export function callWslProjectHost(
  environmentId: string,
  method: string,
  params: unknown
): Promise<unknown> {
  const service = getWslHostService()
  if (!service) {
    throw new Error('WSL hosts are not available on this computer.')
  }
  return service.callProject(environmentId, method, params)
}
