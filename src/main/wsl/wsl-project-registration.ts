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
import { getWslHostService } from './wsl-host-service-instance'
import { wslHostsGateOpen } from './wsl-host-gate'
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
  const targetPath = posix.normalize(
    operation.kind === 'create' ? posix.join(path.linuxPath, operation.name) : path.linuxPath
  )
  const owner = await resolveNewWslProjectHost(store, operation.path, {
    ...options,
    targetKey: foldWslUncPathCaseInsensitiveParts(
      `//wsl.localhost/${path.distro}${targetPath}`.replace(/\/+$/, '')
    )
  })
  if (!owner) {
    return null
  }
  if ('repo' in owner) {
    return owner.repo
  }
  const result = await callWslProjectHost(
    owner.environmentId,
    `repo.${operation.kind}`,
    operation.kind === 'add'
      ? { path: targetPath, kind: operation.repoKind, displayName: operation.displayName }
      : { parentPath: path.linuxPath, name: operation.name, kind: operation.repoKind }
  )
  if (typeof result === 'object' && result && 'error' in result) {
    throw new Error(String(result.error))
  }
  const { repo } = ProjectReply.parse(result)
  return { ...repo, executionHostId: toRuntimeExecutionHostId(owner.environmentId) }
}

/** `targetKey: null` skips the saved-row lookup for callers that already classified their paths. */
export async function resolveNewWslProjectHost(
  store: WslProjectRegistrationStore,
  uncPath: string,
  options: WslProjectRoutingOptions & { targetKey?: string | null } = {}
): Promise<{ repo: Repo } | { environmentId: string; linuxPath: string } | null> {
  const path = parseWslUncPath(uncPath)
  if (!path || !wslProjectRoutingEnabled(store, options.executionHostId)) {
    return null
  }
  const targetKey =
    options.targetKey === undefined
      ? foldWslUncPathCaseInsensitiveParts(uncPath.replace(/[\\/]+$/, ''))
      : options.targetKey
  const existing =
    targetKey === null ? undefined : findSavedWindowsProjectAt(store.getRepos(), targetKey)
  // Existing Windows-owned state belongs to the lossless mover, never a second Add.
  if (existing) {
    return { repo: existing }
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

export function findSavedWindowsProjectAt(repos: Repo[], targetKey: string): Repo | undefined {
  return repos.find(
    (repo) =>
      getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
      foldWslUncPathCaseInsensitiveParts(repo.path.replace(/[\\/]+$/, '')) === targetKey
  )
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
