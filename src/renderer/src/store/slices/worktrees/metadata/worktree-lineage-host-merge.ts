import { getIndexedWorktreesById } from '@/store/worktree-repo-index'
import {
  composeWorktreeHostIdentity,
  isWorktreeHostIdentity,
  getExecutionHostIdFromWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import type { AppState } from '../../../types'
import type {
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../../shared/worktree/lineage-types'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { findWorktreeById, getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { findRepoForHost } from '../../repo-host-identity'
import { reuseEqualRecordMap } from '../../repo-identity-reconcile'

export function getWorktreeHostId(
  state: Pick<AppState, 'repos' | 'settings' | 'worktreesByRepo' | 'detectedWorktreesByRepo'>,
  worktreeId: string,
  instanceId?: string
): ExecutionHostId | null {
  const worktree = instanceId
    ? getIndexedWorktreesById(state.worktreesByRepo, worktreeId).find(
        (row) => row.instanceId === instanceId
      )
    : findWorktreeById(state.worktreesByRepo, worktreeId)
  if (worktree?.hostId) {
    return worktree.hostId
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const detected = state.detectedWorktreesByRepo[repoId]?.worktrees.find(
    (entry) => entry.id === worktreeId
  )
  if (detected?.hostId) {
    return detected.hostId
  }
  const repo = findRepoForHost(state.repos, repoId, { settings: state.settings })
  return repo ? getRepoExecutionHostId(repo) : null
}

export function mergeLineageForHost(
  state: Pick<
    AppState,
    'repos' | 'settings' | 'worktreesByRepo' | 'detectedWorktreesByRepo' | 'worktreeLineageById'
  >,
  hostId: ExecutionHostId,
  lineage: Readonly<Record<string, WorktreeLineage>>,
  lineageAtRequestStart?: Readonly<Record<string, WorktreeLineage>>
): Readonly<Record<string, WorktreeLineage>> {
  // Why per-row and not just per-key: any local write that landed after this request started
  // outranks the reply — a create, a parent reassignment, or a delete the reply would restore.
  const writtenSinceRequestStart = (worktreeId: string): boolean =>
    lineageAtRequestStart !== undefined &&
    lineageAtRequestStart[worktreeId] !== state.worktreeLineageById[worktreeId]
  const next: Record<string, WorktreeLineage> = {}
  for (const [worktreeId, existing] of Object.entries(state.worktreeLineageById)) {
    if (!belongsToRuntimeHost(worktreeId, hostId) || writtenSinceRequestStart(worktreeId)) {
      next[worktreeId] = existing
    }
  }
  for (const [worktreeId, incoming] of Object.entries(lineage)) {
    const childHost = hostId.startsWith('runtime:')
      ? hostId
      : (getWorktreeHostId(state, incoming.worktreeId, incoming.worktreeInstanceId) ?? hostId)
    const key =
      isWorktreeHostIdentity(worktreeId) && hostId === 'local'
        ? worktreeId
        : composeWorktreeHostIdentity(childHost, incoming.worktreeId)
    if (!writtenSinceRequestStart(key)) {
      next[key] = incoming
    }
  }
  return reuseEqualRecordMap(state.worktreeLineageById, next)
}

export function mergeWorkspaceLineageForHost(
  state: Pick<
    AppState,
    | 'repos'
    | 'settings'
    | 'worktreesByRepo'
    | 'detectedWorktreesByRepo'
    | 'workspaceLineageByChildKey'
  >,
  hostId: ExecutionHostId,
  lineage: Readonly<Record<string, WorkspaceLineage>>,
  lineageAtRequestStart?: Readonly<Record<string, WorkspaceLineage>>
): Readonly<Record<string, WorkspaceLineage>> {
  const writtenSinceRequestStart = (childKey: string): boolean =>
    lineageAtRequestStart !== undefined &&
    lineageAtRequestStart[childKey] !== state.workspaceLineageByChildKey[childKey]
  const next: Record<string, WorkspaceLineage> = {}
  for (const [childKey, existing] of Object.entries(state.workspaceLineageByChildKey)) {
    if (!belongsToRuntimeHost(childKey, hostId) || writtenSinceRequestStart(childKey)) {
      next[childKey] = existing
    }
  }
  for (const [childKey, incoming] of Object.entries(lineage)) {
    const childScope = parseWorkspaceKey(incoming.childWorkspaceKey)
    const childHost = hostId.startsWith('runtime:')
      ? hostId
      : childScope?.type === 'worktree'
        ? (getWorktreeHostId(state, childScope.worktreeId, incoming.childInstanceId ?? undefined) ??
          hostId)
        : hostId
    const key =
      isWorktreeHostIdentity(childKey) && hostId === 'local'
        ? childKey
        : composeWorktreeHostIdentity(childHost, incoming.childWorkspaceKey)
    if (!writtenSinceRequestStart(key)) {
      next[key] = incoming
    }
  }
  return reuseEqualRecordMap(state.workspaceLineageByChildKey, next)
}

function belongsToRuntimeHost(key: string, hostId: ExecutionHostId): boolean {
  const owner = getExecutionHostIdFromWorktreeHostIdentity(key)
  return hostId === 'local' ? !owner?.startsWith('runtime:') : owner === hostId
}
