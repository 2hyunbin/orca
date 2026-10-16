import { getIndexedWorktreesById } from '@/store/worktree-repo-index'
import { resolveExactWorktreeRoute } from '@/lib/worktree-owner-route'
import { selectedWorktreeTransport } from '@/lib/selected-worktree-reference'
import {
  getRuntimeTargetHostId,
  runtimeTargetForOwnerEnvironment
} from '@/runtime/runtime-client-target'
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
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
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
  instanceId?: string,
  servingHost?: ExecutionHostId
): ExecutionHostId | null {
  const matches = getIndexedWorktreesById(state.worktreesByRepo, worktreeId).filter((row) => {
    const target = selectedWorktreeTransport(state, row)
    return (
      row.instanceId === instanceId &&
      (!servingHost || (target && getRuntimeTargetHostId(target) === servingHost))
    )
  })
  const worktree = instanceId
    ? matches.length === 1
      ? matches[0]
      : undefined
    : findWorktreeById(state.worktreesByRepo, worktreeId)
  if (worktree?.hostId) {
    return worktree.hostId
  }
  if (instanceId && servingHost) {
    return null
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
    if (!belongsToRuntimeHost(state, worktreeId, hostId) || writtenSinceRequestStart(worktreeId)) {
      next[worktreeId] = existing
    }
  }
  for (const [worktreeId, incoming] of Object.entries(lineage)) {
    const childHost =
      getWorktreeHostId(state, incoming.worktreeId, incoming.worktreeInstanceId, hostId) ?? hostId
    const key = isWorktreeHostIdentity(worktreeId)
      ? worktreeId
      : composeWorktreeHostIdentity(childHost, incoming.worktreeId)
    if (belongsToRuntimeHost(state, key, hostId) && !writtenSinceRequestStart(key)) {
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
    if (!belongsToRuntimeHost(state, childKey, hostId) || writtenSinceRequestStart(childKey)) {
      next[childKey] = existing
    }
  }
  for (const [childKey, incoming] of Object.entries(lineage)) {
    const childScope = parseWorkspaceKey(incoming.childWorkspaceKey)
    const childHost =
      childScope?.type === 'worktree'
        ? (getWorktreeHostId(
            state,
            childScope.worktreeId,
            incoming.childInstanceId ?? undefined,
            hostId
          ) ?? hostId)
        : hostId
    const key = isWorktreeHostIdentity(childKey)
      ? childKey
      : composeWorktreeHostIdentity(childHost, incoming.childWorkspaceKey)
    if (belongsToRuntimeHost(state, key, hostId) && !writtenSinceRequestStart(key)) {
      next[key] = incoming
    }
  }
  return reuseEqualRecordMap(state.workspaceLineageByChildKey, next)
}

function belongsToRuntimeHost(
  state: Pick<AppState, 'repos' | 'worktreesByRepo'>,
  key: string,
  hostId: ExecutionHostId
): boolean {
  const owner = getExecutionHostIdFromWorktreeHostIdentity(key)
  const id = key.slice(key.indexOf('|') + 1)
  const scope = parseWorkspaceKey(id)
  const rowId = scope?.type === 'worktree' ? scope.worktreeId : id
  const row = getIndexedWorktreesById(state.worktreesByRepo, rowId).find(
    (entry) => entry.hostId === owner
  )
  const route = resolveExactWorktreeRoute(state, {
    ...row,
    id,
    repoId: getRepoIdFromWorktreeId(rowId),
    hostId: owner ?? 'local'
  })
  return (
    route.kind === 'resolved' &&
    getRuntimeTargetHostId(runtimeTargetForOwnerEnvironment(route.route.runtimeEnvironmentId)) ===
      hostId
  )
}

export function projectWorktreeLineageToWorkspaceLineage(
  worktreeId: string,
  lineage: WorktreeLineage | null,
  current: Record<string, WorkspaceLineage>,
  hostId?: ExecutionHostId
): Record<string, WorkspaceLineage> {
  const childWorkspaceKey = worktreeWorkspaceKey(worktreeId)
  const key = composeWorktreeHostIdentity(hostId, childWorkspaceKey)
  const next = { ...current }
  if (!lineage) {
    delete next[key]
    return next
  }
  next[key] = {
    childWorkspaceKey,
    childInstanceId: lineage.worktreeInstanceId,
    parentWorkspaceKey: worktreeWorkspaceKey(lineage.parentWorktreeId),
    parentInstanceId: lineage.parentWorktreeInstanceId,
    origin: lineage.origin,
    capture: lineage.capture,
    ...(lineage.taskId ? { taskId: lineage.taskId } : {}),
    ...(lineage.orchestrationRunId ? { orchestrationRunId: lineage.orchestrationRunId } : {}),
    ...(lineage.coordinatorHandle ? { coordinatorHandle: lineage.coordinatorHandle } : {}),
    ...(lineage.createdByTerminalHandle
      ? { createdByTerminalHandle: lineage.createdByTerminalHandle }
      : {}),
    createdAt: lineage.createdAt
  }
  return next
}
