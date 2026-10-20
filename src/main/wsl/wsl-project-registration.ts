import { join } from 'node:path'
import { z } from 'zod'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { getWslHostService } from './wsl-host-service-instance'
import { wslProjectRoutingEnabled } from './wsl-host-gate'
import {
  admitRepositoryCheckout,
  type RepositoryCheckoutAdmission
} from '../repository-checkout-admission'
import type { RpcCallerIdentity } from '../runtime/rpc/rpc-caller-identity'

type WslProjectRegistrationStore = {
  getRepos(): Repo[]
  getSettings?(): Pick<GlobalSettings, 'experimentalWslHosts'>
}

export { wslProjectRoutingEnabled } from './wsl-host-gate'

type WslProjectOperation =
  | { kind: 'add'; path: string; repoKind?: 'git' | 'folder'; displayName?: string }
  | { kind: 'create'; path: string; name: string; repoKind: 'git' | 'folder' }

export type WslProjectRoutingOptions = {
  executionHostId?: ExecutionHostId | null
  /** A paired client cannot address an environment saved only on this Windows desktop. */
  fromPairedClient?: boolean
  admission?: RepositoryCheckoutAdmission
}

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

/** Null keeps the existing route. Callers run their saved-project checks first, so this decides
 *  only who owns a project that no saved row already claims; the guest registers it. */
export async function registerProjectOnWslHost(
  store: WslProjectRegistrationStore,
  operation: WslProjectOperation,
  options: WslProjectRoutingOptions = {}
): Promise<Repo | null> {
  const supplied = options.admission
  const selection = operation.kind === 'add' ? operation.path : join(operation.path, operation.name)
  const sameSelection =
    supplied !== undefined &&
    supplied.executionHostId === (options.executionHostId ?? null) &&
    (supplied.selectedPath === selection || supplied.registrationPath === selection)
  const path = parseWslUncPath(sameSelection ? supplied.selectedPath : operation.path)
  if (!path || !wslProjectRoutingEnabled(store, options.executionHostId)) {
    return null
  }
  const admission =
    sameSelection && supplied.wslRouting
      ? supplied
      : await admitRepositoryCheckout(
          store,
          sameSelection ? supplied.selectedPath : selection,
          operation.kind === 'add' ? operation.repoKind ?? 'git' : 'folder',
          options.executionHostId,
          true
        )
  const saved = admission.findSaved()
  if (saved) {
    return saved
  }
  const owner = await resolveNewWslProjectHost(store, admission.registrationPath, options)
  if (!owner) {
    return null
  }
  const winner = admission.findSaved()
  if (winner) {
    return winner
  }
  if (!wslProjectRoutingEnabled(store, options.executionHostId)) {
    return null
  }
  return registerOnWslOwner(
    owner.environmentId,
    operation.kind === 'add'
      ? { ...operation, path: owner.linuxPath }
      : { ...operation, path: path.linuxPath }
  )
}

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

export const WslNestedImportReply = z.object({
  group: z
    .object({
      id: z.string(),
      name: z.string(),
      parentPath: z.string().nullable(),
      parentGroupId: z.string().nullable(),
      createdFrom: z.enum(['manual', 'folder-scan', 'migration']),
      tabOrder: z.number(),
      isCollapsed: z.boolean(),
      color: z.string().nullable(),
      createdAt: z.number(),
      updatedAt: z.number()
    })
    .passthrough()
    .optional(),
  projects: z.array(
    z.object({
      path: z.string(),
      projectId: z.string().optional(),
      status: z.enum(['imported', 'already-known', 'failed']),
      error: z.string().optional()
    })
  ),
  importedCount: z.number(),
  alreadyKnownCount: z.number(),
  failedCount: z.number()
})

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

/** Only called after canonical admission has settled the saved checkout claim. */
export async function resolveNewWslProjectHost(
  store: WslProjectRegistrationStore,
  uncPath: string,
  options: WslProjectRoutingOptions = {}
): Promise<{ environmentId: string; linuxPath: string } | null> {
  const path = parseWslUncPath(uncPath)
  if (!path || !wslProjectRoutingEnabled(store, options.executionHostId)) {
    return null
  }
  if (options.fromPairedClient) {
    throw new Error('Add this WSL project from the Windows desktop, then open it on its WSL host.')
  }
  const service = getWslHostService()
  if (!service) {
    throw new Error(
      'WSL projects need the desktop app for now. Open Orca on Windows and add this project there.'
    )
  }
  return { environmentId: await service.ensure(path.distro), linuxPath: path.linuxPath }
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
