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
import { wslHostsGateOpen } from './wsl-host-gate'
import {
  admitRepositoryCheckout,
  type RepositoryCheckoutAdmission
} from '../repository-checkout-admission'
import type { RpcCallerIdentity } from '../runtime/rpc/rpc-caller-identity'

type WslProjectRegistrationStore = {
  getRepos(): Repo[]
  getSettings?(): Pick<GlobalSettings, 'experimentalWslHosts'>
}

export function wslProjectRoutingEnabled(
  store: WslProjectRegistrationStore,
  executionHostId?: ExecutionHostId | null
): boolean {
  return (
    process.platform === 'win32' &&
    (executionHostId == null || executionHostId === LOCAL_EXECUTION_HOST_ID) &&
    wslHostsGateOpen() &&
    (getWslHostService()?.isEnabled() ?? store.getSettings?.().experimentalWslHosts === true)
  )
}

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
  const path = parseWslUncPath(operation.path)
  if (!path || !wslProjectRoutingEnabled(store, options.executionHostId)) {
    return null
  }
  const admission =
    operation.kind === 'add'
      ? options.admission ??
        await admitRepositoryCheckout(
          store, operation.path, operation.repoKind ?? 'git', LOCAL_EXECUTION_HOST_ID
        )
      : await admitRepositoryCheckout(
          store, join(operation.path, operation.name), 'folder', LOCAL_EXECUTION_HOST_ID
        )
  const saved = admission.findSaved()
  if (saved) return saved
  const owner = await resolveNewWslProjectHost(store, admission.registrationPath, options)
  if (!owner) {
    return null
  }
  const winner = admission.findSaved()
  if (winner) return winner
  return registerOnWslOwner(
    owner.environmentId,
    operation.kind === 'add'
      ? { ...operation, path: owner.linuxPath }
      : { ...operation, path: path.linuxPath }
  )
}

const OwnerRepos = z.object({ repos: z.array(ProjectReply.shape.repo) })
const OwnerSetups = z.object({
  setups: z.array(z.object({
    projectId: z.string(),
    repoId: z.string(),
    path: z.string(),
    hostId: z.string(),
    setupMethod: z.enum(['legacy-repo', 'imported-existing-folder', 'cloned', 'provisioned'])
  }))
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
    const setup = setups.find((row) =>
      row.repoId === repo.id && row.path === repo.path && row.hostId === getRepoExecutionHostId(repo)
    )
    const { projects } = OwnerProjects.parse(
      await callWslProjectHost(environmentId, 'project.list', undefined)
    )
    if (!setup || !projects.some((project) => project.id === setup.projectId)) {
      throw new Error('The project was added, but its host setup could not be prepared.')
    }
    // A concurrent explicit registration owns its provenance, even if our earlier snapshot missed it.
    if (setup.setupMethod === 'legacy-repo' && repo.projectHostSetupMethod == null) {
      const result = await callWslProjectHost(environmentId, 'projectHostSetup.setupExistingFolder', {
        projectId: setup.projectId,
        hostId: LOCAL_EXECUTION_HOST_ID,
        path: repo.path,
        kind: 'git',
        setupMethod: 'imported-existing-folder'
      })
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
