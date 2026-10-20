import { isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  adoptEndpointProjectHostSetup,
  adoptEndpointRepo
} from '../../shared/endpoint-catalog-adoption'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type {
  Project,
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult
} from '../../shared/project-types'
import {
  placeProject,
  type PlacementCaller,
  type PlacementStore,
  type ProjectPlacement,
  type WslPlacement
} from './project-placement'
import type { SavedClaimRule } from '../repository-checkout-admission'
import { callWslProjectHost } from './wsl-project-registration'

const SetupReply = z.object({
  result: z.object({
    project: z
      .object({
        id: z.string(),
        displayName: z.string(),
        badgeColor: z.string(),
        sourceRepoIds: z.array(z.string()),
        createdAt: z.number(),
        updatedAt: z.number()
      })
      .passthrough(),
    setup: z
      .object({
        id: z.string(),
        projectId: z.string(),
        hostId: z.literal('local'),
        repoId: z.string(),
        path: z.string(),
        displayName: z.string(),
        setupState: z.enum(['ready', 'not-set-up', 'setting-up', 'error', 'unsupported']),
        setupMethod: z.enum(['legacy-repo', 'imported-existing-folder', 'cloned', 'provisioned']),
        createdAt: z.number(),
        updatedAt: z.number()
      })
      .passthrough(),
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
})

/** Setup places its folder once: a WSL owner links it there; anything else returns to the caller's writer. */
export async function placeExistingFolderSetup(
  store: PlacementStore & { getProjects?(): Project[] },
  args: ProjectHostSetupExistingFolderArgs,
  caller: PlacementCaller & { claimsOutsideWsl: Exclude<SavedClaimRule, { scope: 'wsl' }> }
): Promise<{ hosted: ProjectHostSetupResult } | { placement: Exclude<ProjectPlacement, WslPlacement> }> {
  if (!isAbsolute(args.path)) {
    throw new Error('Project path must be an absolute path')
  }
  const placement = await placeProject(store, {
    operation: 'setup',
    selectedPath: args.path,
    kind: args.kind === 'folder' ? 'folder' : 'git',
    ...caller
  })
  return placement.kind === 'wsl'
    ? { hosted: await setupProjectOnWslOwner(store, args, placement) }
    : { placement }
}

/** Linking an existing project must also happen in the guest's catalog transaction. */
async function setupProjectOnWslOwner(
  store: { getProjects?(): Project[] },
  args: ProjectHostSetupExistingFolderArgs,
  owner: WslPlacement
): Promise<ProjectHostSetupResult> {
  // Why: the guest has never seen this desktop's project, so its identity travels with the link.
  const projectProviderIdentity =
    args.projectProviderIdentity ??
    store.getProjects?.().find((project) => project.id === args.projectId)?.providerIdentity
  const response = await callWslProjectHost(
    owner.environmentId,
    'projectHostSetup.setupExistingFolder',
    {
      ...args,
      hostId: LOCAL_EXECUTION_HOST_ID,
      path: owner.linuxPath,
      ...(projectProviderIdentity ? { projectProviderIdentity } : {})
    }
  )
  const { result } = SetupReply.parse(response)
  const target = { kind: 'environment' as const, environmentId: owner.environmentId }
  return {
    ...result,
    repo: adoptEndpointRepo(target, result.repo),
    setup: adoptEndpointProjectHostSetup(target, result.setup)
  }
}
