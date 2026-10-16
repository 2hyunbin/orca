import type { WorktreeIdentity } from '../../../../../../shared/worktree/identity'
import {
  resolveSelectedWorktree,
  type SelectedWorktreeReference
} from '@/lib/selected-worktree-reference'
export { listWorktreeLineageForRuntime } from './worktree-lineage-list'
import { listWorktreeLineageForRuntime } from './worktree-lineage-list'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { StateCreator } from 'zustand'
import type { AppState } from '../../../types'
import type {
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { callRuntimeRpc } from '../../../../runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { getRuntimeTargetHostId } from '../../../../runtime/runtime-client-target'
import { toRuntimeWorktreeSelector } from '../../../../runtime/runtime-worktree-selector'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { mergeLineageForHost, mergeWorkspaceLineageForHost } from './worktree-lineage-host-merge'
import { beginWorktreeLineageRefresh } from './worktree-lineage-readiness'
import type {
  BackgroundRuntimeRefreshOptions,
  WorktreeLineageUpdateResult,
  WorktreeWithLineage
} from '../listing/worktree-slice-types'

/** Per-row baseline the reply is merged against, so any local write since then outranks it. */
type LineageAtRequestStart = {
  worktreeLineageById: Readonly<Record<string, WorktreeLineage>>
  workspaceLineageByChildKey: Readonly<Record<string, WorkspaceLineage>>
}

function captureLineageAtRequestStart(
  state: Pick<AppState, 'worktreeLineageById' | 'workspaceLineageByChildKey'>
): LineageAtRequestStart {
  return {
    worktreeLineageById: state.worktreeLineageById,
    workspaceLineageByChildKey: state.workspaceLineageByChildKey
  }
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

export async function setWorktreeLineageForRuntime(
  target: RuntimeClientTarget,
  reference: SelectedWorktreeReference,
  args: { parentWorktreeId?: string; noParent?: boolean },
  selector: string
): Promise<WorktreeLineageUpdateResult> {
  if (target.kind === 'local') {
    return {
      target,
      reference,
      lineage: await window.api.worktrees.updateLineage({
        worktreeId: selector,
        ...(args.parentWorktreeId ? { parentWorktreeId: args.parentWorktreeId } : {}),
        ...(args.noParent === true ? { noParent: true } : {})
      })
    }
  }
  const result = await callRuntimeRpc<{ worktree: WorktreeWithLineage }>(
    target,
    'worktree.set',
    {
      worktree: selector,
      ...(args.parentWorktreeId
        ? {
            parentWorktree: args.parentWorktreeId.startsWith('identity:')
              ? args.parentWorktreeId
              : toRuntimeWorktreeSelector(args.parentWorktreeId)
          }
        : {}),
      ...(args.noParent === true ? { noParent: true } : {})
    },
    { timeoutMs: 15_000 }
  )
  return {
    target,
    reference,
    lineage: result.worktree.lineage ?? null,
    updatedRemoteWorktree: result.worktree
  }
}

export function projectLocalWorktreeLineageUpdate(
  worktreesByRepo: Record<string, Worktree[]>,
  worktreeId: string,
  lineage: WorktreeLineage | null,
  identity: WorktreeIdentity,
  previousParentInstanceId?: string
): Record<string, Worktree[]> {
  let nextByRepo = worktreesByRepo
  for (const [repoId, worktrees] of Object.entries(worktreesByRepo)) {
    let repoChanged = false
    const projected = worktrees.map((worktree) => {
      const current: WorktreeWithLineage = worktree
      const hadChild =
        current.childWorktreeIds?.includes(worktreeId) === true &&
        worktree.instanceId === previousParentInstanceId
      const isParent = Boolean(lineage && lineage.parentWorktreeInstanceId === worktree.instanceId)
      let childWorktreeIds = current.childWorktreeIds
      if (hadChild) {
        childWorktreeIds = childWorktreeIds?.filter((id) => id !== worktreeId)
      }
      if (isParent && !childWorktreeIds?.includes(worktreeId)) {
        childWorktreeIds = [...(childWorktreeIds ?? []), worktreeId]
      }
      if (worktree.identity?.key === identity.key) {
        repoChanged = true
        return {
          ...worktree,
          parentWorktreeId: lineage?.parentWorktreeId ?? null,
          lineage
        }
      }
      if (hadChild || isParent) {
        repoChanged = true
        return { ...worktree, childWorktreeIds }
      }
      return worktree
    })
    if (repoChanged) {
      if (nextByRepo === worktreesByRepo) {
        nextByRepo = { ...worktreesByRepo }
      }
      nextByRepo[repoId] = projected
    }
  }
  return nextByRepo
}

export function applyWorktreeLineageUpdate(
  set: Parameters<StateCreator<AppState>>[0],
  result: WorktreeLineageUpdateResult
): void {
  set((s) => {
    const child = resolveSelectedWorktree(s, result.reference)?.row
    if (!child?.identity) {
      throw new Error('selector_not_found')
    }
    const worktreeId = child.id
    const hostId = child.hostId
    const key = composeWorktreeHostIdentity(hostId, worktreeId)
    const next = { ...s.worktreeLineageById }
    if (result.lineage) {
      next[key] = result.lineage
    } else {
      delete next[key]
    }
    const previous: WorktreeWithLineage = child
    const worktreesByRepo = projectLocalWorktreeLineageUpdate(
      s.worktreesByRepo,
      worktreeId,
      result.lineage,
      child.identity,
      s.worktreeLineageById[key]?.parentWorktreeInstanceId ??
        previous.lineage?.parentWorktreeInstanceId
    )
    return {
      worktreeLineageById: next,
      workspaceLineageByChildKey: projectWorktreeLineageToWorkspaceLineage(
        worktreeId,
        result.lineage,
        s.workspaceLineageByChildKey,
        hostId
      ),
      worktreesByRepo,
      sortEpoch: s.sortEpoch + 1
    }
  })
}

export function applyHostLineageRefresh(
  set: Parameters<StateCreator<AppState>>[0],
  hostId: ExecutionHostId,
  lineage: {
    worktreeLineageById: Readonly<Record<string, WorktreeLineage>>
    workspaceLineageByChildKey: Readonly<Record<string, WorkspaceLineage>>
  },
  lineageAtRequestStart?: LineageAtRequestStart
): void {
  set((s) => {
    const worktreeLineageById = mergeLineageForHost(
      s,
      hostId,
      lineage.worktreeLineageById,
      lineageAtRequestStart?.worktreeLineageById
    )
    const workspaceLineageByChildKey = mergeWorkspaceLineageForHost(
      s,
      hostId,
      lineage.workspaceLineageByChildKey,
      lineageAtRequestStart?.workspaceLineageByChildKey
    )
    if (
      worktreeLineageById === s.worktreeLineageById &&
      workspaceLineageByChildKey === s.workspaceLineageByChildKey
    ) {
      return s
    }
    return { worktreeLineageById, workspaceLineageByChildKey }
  })
}

export async function refreshWorktreeLineageForTarget(
  target: RuntimeClientTarget,
  set: Parameters<StateCreator<AppState>>[0],
  getState: () => Pick<AppState, 'worktreeLineageById' | 'workspaceLineageByChildKey'>,
  options: BackgroundRuntimeRefreshOptions = {}
): Promise<void> {
  const finish = beginWorktreeLineageRefresh(getState, target)
  let succeeded = false
  try {
    const lineageAtRequestStart = captureLineageAtRequestStart(getState())
    const lineage = await listWorktreeLineageForRuntime(target, options)
    applyHostLineageRefresh(set, getRuntimeTargetHostId(target), lineage, lineageAtRequestStart)
    succeeded = true
  } finally {
    finish(succeeded)
  }
}

export async function refreshRemoteWorktreeLineageBestEffort(
  target: RuntimeClientTarget | null,
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  getState: () => Pick<AppState, 'worktreeLineageById' | 'workspaceLineageByChildKey'>
): Promise<void> {
  if (target?.kind !== 'environment') {
    return
  }
  try {
    await refreshWorktreeLineageForTarget(target, set, getState, {
      reuseRecentCompatibilityFailure: true
    })
  } catch (err) {
    // Why: lineage is supplemental, so a remote timeout here must not discard a successful worktree refresh.
    console.error('Failed to fetch worktree lineage:', err)
  }
}
