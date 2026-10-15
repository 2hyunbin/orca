import { z } from 'zod'
import { getAppEnvironment } from '../../shared/app-environment'
import { adoptEndpointProjectHostSetup, adoptEndpointRepo } from '../../shared/endpoint-catalog-adoption'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type {
  ProjectHostSetupCloneArgs,
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult
} from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import { foldWslUncPathCaseInsensitiveParts, parseWslUncPath } from '../../shared/wsl-paths'
import { deriveCloneRepoNameFromUrl } from '../git/repo-clone-path'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import { resolveNewWslProjectHost } from './wsl-project-registration'

const SetupReply = z.object({ result: z.object({
  project: z.object({
    id: z.string(), displayName: z.string(), badgeColor: z.string(),
    sourceRepoIds: z.array(z.string()), createdAt: z.number(), updatedAt: z.number()
  }).passthrough(),
  setup: z.object({
    id: z.string(), projectId: z.string(), hostId: z.literal('local'),
    repoId: z.string(), path: z.string(), displayName: z.string(),
    setupState: z.enum(['ready', 'not-set-up', 'setting-up', 'error', 'unsupported']),
    setupMethod: z.enum(['legacy-repo', 'imported-existing-folder', 'cloned', 'provisioned']),
    createdAt: z.number(), updatedAt: z.number()
  }).passthrough(),
  repo: z.object({
    id: z.string(), path: z.string(), displayName: z.string(), badgeColor: z.string(),
    addedAt: z.number(), kind: z.enum(['git', 'folder']).optional()
  }).passthrough()
}) })

/** Linking an existing project must also happen in the guest's catalog transaction. */
export async function setupProjectOnWslHost(
  store: { getRepos(): Repo[] },
  args: ProjectHostSetupExistingFolderArgs | ProjectHostSetupCloneArgs
): Promise<ProjectHostSetupResult | null> {
  const cloning = 'destination' in args
  const uncPath = cloning ? args.destination : args.path
  const path = parseWslUncPath(uncPath)
  const targetKey = cloning && path
    ? foldWslUncPathCaseInsensitiveParts(`${uncPath.replace(/[\\/]+$/, '')}/${deriveCloneRepoNameFromUrl(args.url)}`)
    : undefined
  const owner = await resolveNewWslProjectHost(store, uncPath, targetKey, args.hostId)
  if (!owner || 'repo' in owner) {
    return null
  }
  const response = await callRuntimeEnvironment(
    getAppEnvironment().getPath('userData'), owner.environmentId,
    cloning ? 'projectHostSetup.clone' : 'projectHostSetup.setupExistingFolder',
    {
      ...args, hostId: LOCAL_EXECUTION_HOST_ID,
      ...(cloning ? { destination: owner.linuxPath } : { path: owner.linuxPath })
    },
    10 * 60_000
  )
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  const { result } = SetupReply.parse(response.result)
  const target = { kind: 'environment' as const, environmentId: owner.environmentId }
  return {
    ...result,
    repo: adoptEndpointRepo(target, result.repo),
    setup: adoptEndpointProjectHostSetup(target, result.setup)
  }
}
