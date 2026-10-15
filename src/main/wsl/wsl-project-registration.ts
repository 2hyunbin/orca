import { posix } from 'node:path'
import { z } from 'zod'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { foldWslUncPathCaseInsensitiveParts, parseWslUncPath } from '../../shared/wsl-paths'
import { deriveCloneRepoNameFromUrl } from '../git/repo-clone-path'
import { getWslHostService } from './wsl-host-service-instance'
import { wslHostsGateOpen } from './wsl-host-gate'
import type { RpcCallerIdentity } from '../runtime/rpc/rpc-caller-identity'

type WslProjectRegistrationStore = {
  getRepos(): Repo[]
  getSettings?(): Pick<GlobalSettings, 'experimentalWslHosts'>
}

function wslProjectRoutingEnabled(store: WslProjectRegistrationStore): boolean {
  return getWslHostService()?.isEnabled() ?? store.getSettings?.().experimentalWslHosts === true
}

type WslProjectOperation =
  | { kind: 'add'; path: string; repoKind?: 'git' | 'folder'; displayName?: string }
  | { kind: 'clone'; path: string; url: string }
  | { kind: 'create'; path: string; name: string; repoKind: 'git' | 'folder' }

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

/** Null keeps the existing route; a WSL result is owned and registered only by the guest. */
export async function registerProjectOnWslHost(
  store: WslProjectRegistrationStore,
  operation: WslProjectOperation,
  executionHostId?: ExecutionHostId | null
): Promise<Repo | null> {
  if (
    process.platform !== 'win32' ||
    (executionHostId != null && executionHostId !== LOCAL_EXECUTION_HOST_ID) ||
    !wslHostsGateOpen()
  ) {
    return null
  }
  const path = parseWslUncPath(operation.path)
  if (!path || !wslProjectRoutingEnabled(store)) {
    return null
  }
  const name =
    operation.kind === 'clone'
      ? deriveCloneRepoNameFromUrl(operation.url)
      : operation.kind === 'create'
        ? operation.name.trim()
        : null
  if (name !== null && (!name || /[\\/]/.test(name) || name === '.' || name === '..')) {
    throw new Error('Invalid project name')
  }
  const targetPath = posix.normalize(name === null ? path.linuxPath : posix.join(path.linuxPath, name))
  const targetKey = foldWslUncPathCaseInsensitiveParts(
    `//wsl.localhost/${path.distro}${targetPath}`
  )
  const owner = await resolveNewWslProjectHost(store, operation.path, targetKey, executionHostId)
  if (!owner) {
    return null
  }
  if ('repo' in owner) {
    return owner.repo
  }
  const { environmentId } = owner
  const method = `repo.${operation.kind}`
  const params =
    operation.kind === 'add'
      ? { path: targetPath, kind: operation.repoKind, displayName: operation.displayName }
      : operation.kind === 'clone'
        ? { destination: path.linuxPath, url: operation.url }
        : { parentPath: path.linuxPath, name, kind: operation.repoKind }
  const result = await callWslProjectHost(environmentId, method, params)
  if (typeof result === 'object' && result && 'error' in result) {
    throw new Error(String(result.error))
  }
  const { repo } = ProjectReply.parse(result)
  return { ...repo, executionHostId: toRuntimeExecutionHostId(environmentId) }
}

export async function resolveNewWslProjectHost(
  store: WslProjectRegistrationStore,
  uncPath: string,
  targetKey = foldWslUncPathCaseInsensitiveParts(uncPath.replace(/[\\/]+$/, '')),
  executionHostId?: ExecutionHostId | null
): Promise<{ repo: Repo } | { environmentId: string; linuxPath: string } | null> {
  if (
    process.platform !== 'win32' ||
    (executionHostId != null && executionHostId !== LOCAL_EXECUTION_HOST_ID) ||
    !wslHostsGateOpen()
  ) {
    return null
  }
  const path = parseWslUncPath(uncPath)
  const service = getWslHostService()
  if (!path || !wslProjectRoutingEnabled(store)) {
    return null
  }
  const existing = store.getRepos().find(
    (repo) =>
      targetKey !== null &&
      getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
      foldWslUncPathCaseInsensitiveParts(repo.path.replace(/[\\/]+$/, '')) === targetKey
  )
  // Existing Windows-owned state belongs to the lossless mover, never a second Add.
  if (existing) {
    return { repo: existing }
  }
  if (!service) {
    throw new Error(
      'WSL projects need the desktop app for now. Open Orca on Windows and add this project there.'
    )
  }
  return { environmentId: await service.ensure(path.distro), linuxPath: path.linuxPath }
}

/** A paired client cannot address an environment saved only on this Windows desktop. */
export function assertWslProjectRoutingCaller(path: string, caller?: RpcCallerIdentity): void {
  if (
    process.platform === 'win32' &&
    parseWslUncPath(path) &&
    wslHostsGateOpen() &&
    getWslHostService()?.isEnabled() &&
    caller?.kind !== 'local-cli' &&
    caller?.kind !== 'desktop'
  ) {
    throw new Error('Add this WSL project from the Windows desktop, then open it on its WSL host.')
  }
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
