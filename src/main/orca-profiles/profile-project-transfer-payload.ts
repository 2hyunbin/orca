import { getAllWorktreeMetaForHost } from '../persistence/loading-store/worktree-identity-metadata'
import { canonicalWorktreeIdentity } from '../../shared/worktree/identity'
import { composeWorktreeHostIdentity } from '../../shared/worktree/host-qualified-identity'
import { refreshLegacyLineage } from '../persistence/loading-store/canonical-workspace-lineage'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { randomUUID } from 'node:crypto'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../shared/project-host-setup-projection'
import type { SshTarget } from '../../shared/ssh-types'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { Repo } from '../../shared/repo-types'
import type { SparsePreset } from '../../shared/worktree/create-types'
import type { RetiredNameRegistry } from '../../shared/worktree/retired-name-registry'
import {
  extractRetiredNameRegistriesByNamespace,
  mergeRetiredNameRegistryMaps
} from './profile-project-retired-name-transfer'
import type { TransferProfileState } from './profile-project-state-file'
import { rebuildRepoBackedProjectState } from './profile-project-state-file'
import { mergeHostWorkspaceSessions, mergeWorkspaceSessions } from './profile-project-session-state'
import {
  extractHostSessionsForTransfer,
  extractSessionForTransfer
} from './profile-project-session-transfer'
import { collectTransferWorktreeIds } from './profile-project-transfer-worktree-ids'
import { rekeyWorktreeId, rekeyWorkspaceKey } from './profile-project-worktree-identity'

export type TransferPayload = {
  repo: Repo
  sparsePresets: SparsePreset[]
  /** Generated names already spent for this repo, compacted. Carried so the destination profile
   *  does not reissue a name whose old directory still holds agent state. */
  retiredNameRegistry: RetiredNameRegistry | undefined
  retiredNameRegistriesByNamespace: Record<string, RetiredNameRegistry>
  lineageByChildInstance?: PersistedState['lineageByChildInstance']
  worktreeMeta: PersistedState['worktreeMeta']
  workspaceSession?: PersistedState['workspaceSession']
  workspaceSessionsByHostId?: Partial<Record<ExecutionHostId, PersistedState['workspaceSession']>>
  sshTargets: SshTarget[]
  targetProjectId: string | null
}

export function createTargetRepo(
  sourceRepo: Repo,
  targetState: TransferProfileState,
  copy: boolean
): Repo {
  const targetRepoId =
    !copy && !targetState.repos.some((repo) => repo.id === sourceRepo.id)
      ? sourceRepo.id
      : createUniqueRepoId(targetState)
  const repo: Repo = {
    ...sourceRepo,
    id: targetRepoId,
    projectGroupId: null,
    addedAt: copy ? Date.now() : sourceRepo.addedAt
  }
  delete repo.projectGroupOrder
  return repo
}

function createUniqueRepoId(state: TransferProfileState): string {
  const existingRepoIds = new Set(state.repos.map((repo) => repo.id))
  let candidate = randomUUID()
  while (existingRepoIds.has(candidate)) {
    candidate = randomUUID()
  }
  return candidate
}

function rekeyWorktreeIdRecord<T>(
  record: Record<string, T>,
  worktreeIds: ReadonlySet<string>,
  oldRepoId: string,
  newRepoId: string,
  mapValue: (value: T) => T = (value) => structuredClone(value)
): Record<string, T> {
  const next: Record<string, T> = {}
  for (const [oldKey, value] of Object.entries(record)) {
    if (worktreeIds.has(oldKey)) {
      next[rekeyWorktreeId(oldRepoId, newRepoId, oldKey)] = mapValue(value)
    }
  }
  return next
}

export function createTransferPayload(args: {
  sourceState: TransferProfileState
  sourceRepo: Repo
  targetRepo: Repo
  includeSessions: boolean
}): TransferPayload {
  const { sourceState, sourceRepo, targetRepo, includeSessions } = args
  const oldRepoId = sourceRepo.id
  const newRepoId = targetRepo.id
  const worktreeIds = collectTransferWorktreeIds(sourceState, oldRepoId)
  const sourceMeta = getAllWorktreeMetaForHost(
    { state: sourceState },
    getRepoExecutionHostId(sourceRepo)
  )
  const sourceInstances = new Set(
    Object.entries(sourceMeta)
      .filter(([id]) => worktreeIds.has(id))
      .map(([, meta]) => meta.instanceId)
  )
  const targetProjection = projectHostSetupProjectionFromRepos([targetRepo])
  const targetProjectId =
    targetProjection.setups[0]?.projectId ?? targetProjection.projects[0]?.id ?? null
  return {
    repo: targetRepo,
    lineageByChildInstance: Object.fromEntries(
      Object.entries(sourceState.lineageByChildInstance ?? {}).flatMap(([instance, edge]) => {
        const child = parseWorkspaceKey(edge.child.locator)
        if (
          child?.type !== 'worktree' ||
          !worktreeIds.has(child.worktreeId) ||
          !sourceInstances.has(edge.child.instanceId)
        ) {
          return []
        }
        return [
          [
            instance,
            {
              ...structuredClone(edge),
              child: {
                ...edge.child,
                locator: rekeyWorkspaceKey(oldRepoId, newRepoId, edge.child.locator),
                hostId: getRepoExecutionHostId(targetRepo)
              }
            }
          ]
        ]
      })
    ),
    sparsePresets: (sourceState.sparsePresetsByRepo[oldRepoId] ?? []).map((preset) => ({
      ...structuredClone(preset),
      repoId: newRepoId
    })),
    retiredNameRegistry: sourceState.retiredWorktreeNamesByRepo?.[oldRepoId],
    retiredNameRegistriesByNamespace: extractRetiredNameRegistriesByNamespace(
      sourceState,
      sourceRepo
    ),
    worktreeMeta: rekeyWorktreeIdRecord(sourceMeta, worktreeIds, oldRepoId, newRepoId, (meta) => ({
      ...structuredClone(meta),
      ...(targetProjectId ? { projectId: targetProjectId } : {}),
      hostId: getRepoExecutionHostId(targetRepo),
      projectHostSetupId: targetRepo.id
    })),
    ...(includeSessions
      ? {
          workspaceSession: extractSessionForTransfer(
            sourceState.workspaceSession,
            oldRepoId,
            newRepoId
          ),
          workspaceSessionsByHostId: extractHostSessionsForTransfer(
            sourceState.workspaceSessionsByHostId,
            oldRepoId,
            newRepoId
          )
        }
      : {}),
    sshTargets: sourceRepo.connectionId
      ? sourceState.sshTargets.filter((target) => target.id === sourceRepo.connectionId)
      : [],
    targetProjectId
  }
}

export function applyPayloadToTarget(
  targetState: TransferProfileState,
  payload: TransferPayload
): TransferProfileState {
  const next: TransferProfileState = {
    ...targetState,
    repos: [...targetState.repos, payload.repo],
    sparsePresetsByRepo: {
      ...targetState.sparsePresetsByRepo,
      ...(payload.sparsePresets.length > 0 ? { [payload.repo.id]: payload.sparsePresets } : {})
    },
    retiredWorktreeNamesByRepo: {
      ...targetState.retiredWorktreeNamesByRepo,
      ...(payload.retiredNameRegistry ? { [payload.repo.id]: payload.retiredNameRegistry } : {})
    },
    retiredWorktreeNamesByNamespace: mergeRetiredNameRegistryMaps(
      targetState.retiredWorktreeNamesByNamespace ?? {},
      payload.retiredNameRegistriesByNamespace
    ),

    worktreeMeta: { ...targetState.worktreeMeta, ...payload.worktreeMeta },
    lineageByChildInstance: {
      ...targetState.lineageByChildInstance,
      ...payload.lineageByChildInstance
    },
    sshTargets: mergeSshTargets(targetState.sshTargets, payload.sshTargets)
  }
  next.worktreeMetaByIdentity = { ...targetState.worktreeMetaByIdentity }
  next.worktreeIdentityAliases = { ...targetState.worktreeIdentityAliases }
  for (const [id, meta] of Object.entries(payload.worktreeMeta)) {
    if (!meta.instanceId) {
      continue
    }
    const hostId = getRepoExecutionHostId(payload.repo)
    const identity = canonicalWorktreeIdentity({
      worktreeId: id,
      instanceId: meta.instanceId,
      executionHostId: hostId
    })
    next.worktreeMetaByIdentity[identity] = meta
    next.worktreeIdentityAliases[composeWorktreeHostIdentity(hostId, id)] = [identity]
  }
  refreshLegacyLineage(next)
  if (payload.workspaceSession) {
    next.workspaceSession = mergeWorkspaceSessions(
      targetState.workspaceSession,
      payload.workspaceSession
    )
  }
  if (payload.workspaceSessionsByHostId) {
    next.workspaceSessionsByHostId = mergeHostWorkspaceSessions(
      targetState.workspaceSessionsByHostId,
      payload.workspaceSessionsByHostId
    )
  }
  return rebuildRepoBackedProjectState(next)
}

function mergeSshTargets(existing: SshTarget[], incoming: SshTarget[]): SshTarget[] {
  const existingIds = new Set(existing.map((target) => target.id))
  return [...existing, ...incoming.filter((target) => !existingIds.has(target.id))]
}
