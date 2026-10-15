import { posix } from 'node:path'
import { z } from 'zod'
import { getAppEnvironment } from '../../shared/app-environment'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import { foldWslUncPathCaseInsensitiveParts, parseWslUncPath } from '../../shared/wsl-paths'
import { deriveCloneRepoNameFromUrl } from '../git/repo-clone-path'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import { getWslHostService } from './wsl-host-service-instance'
import { wslHostsGateOpen } from './wsl-host-gate'

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
  store: { getRepos(): Repo[] },
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
  const service = getWslHostService()
  if (!path || !service?.isEnabled()) {
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
  const response = await callRuntimeEnvironment(
    getAppEnvironment().getPath('userData'),
    environmentId,
    method,
    params,
    10 * 60_000
  )
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  if (typeof response.result === 'object' && response.result && 'error' in response.result) {
    throw new Error(String(response.result.error))
  }
  const { repo } = ProjectReply.parse(response.result)
  return { ...repo, executionHostId: toRuntimeExecutionHostId(environmentId) }
}

export async function resolveNewWslProjectHost(
  store: { getRepos(): Repo[] },
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
  if (!path || !service?.isEnabled()) {
    return null
  }
  const existing = store.getRepos().find((repo) =>
    getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
    foldWslUncPathCaseInsensitiveParts(repo.path.replace(/[\\/]+$/, '')) === targetKey
  )
  // Existing Windows-owned state belongs to the lossless mover, never a second Add.
  return existing
    ? { repo: existing }
    : { environmentId: await service.ensure(path.distro), linuxPath: path.linuxPath }
}
