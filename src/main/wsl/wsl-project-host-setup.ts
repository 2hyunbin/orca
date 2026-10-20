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
import { parseWslUncPath } from '../../shared/wsl-paths'
import { admitRepositoryCheckout } from '../repository-checkout-admission'
import type { Repo } from '../../shared/repo-types'
import {
  callWslProjectHost,
  resolveNewWslProjectHost,
  wslProjectRoutingEnabled
} from './wsl-project-registration'

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

/** Linking an existing project must also happen in the guest's catalog transaction. */
export async function setupProjectOnWslHost(
  store: { getRepos(): Repo[]; getProjects?(): Project[] },
  args: ProjectHostSetupExistingFolderArgs,
  options: { fromPairedClient?: boolean } = {}
): Promise<ProjectHostSetupResult | null> {
  if (!parseWslUncPath(args.path) || !wslProjectRoutingEnabled(store, args.hostId)) {
    return null
  }
  const admission = await admitRepositoryCheckout(
    store,
    args.path,
    args.kind ?? 'git',
    LOCAL_EXECUTION_HOST_ID,
    true
  )
  if (admission.findSaved()) {
    return null
  }
  const owner = await resolveNewWslProjectHost(store, admission.registrationPath, {
    ...options,
    executionHostId: args.hostId
  })
  if (!owner || admission.findSaved() || !wslProjectRoutingEnabled(store, args.hostId)) {
    return null
  }
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
