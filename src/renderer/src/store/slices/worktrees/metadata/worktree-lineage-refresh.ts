import {
  resolveSelectedWorktree,
  selectedWorktreeTransport,
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
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  mergeLineageForHost,
  mergeWorkspaceLineageForHost,
  projectWorktreeLineageToWorkspaceLineage
} from './worktree-lineage-host-merge'
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

export async function setWorktreeLineageForRuntime(
  target: RuntimeClientTarget,
  reference: SelectedWorktreeReference,
  args: { parentWorktreeId?: string; noParent?: boolean },
  selector: string
): Promise<WorktreeLineageUpdateResult> {
  if (target.kind === 'local') {
    return {
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
    reference,
    lineage: result.worktree.lineage ?? null
  }
}

export function projectLocalWorktreeLineageUpdate(
  state: AppState,
  worktreeId: string,
  lineage: WorktreeLineage | null,
  child: Worktree,
  previousParentInstanceId?: string
): Record<string, Worktree[]> {
  const worktreesByRepo = state.worktreesByRepo
  const authority = selectedWorktreeTransport(state, child)
  const parentRow = (instance: string | undefined, id: string | undefined) => {
    const matches = Object.values(worktreesByRepo)
      .flat()
      .filter((row) => {
        const target = selectedWorktreeTransport(state, row)
        return (
          instance &&
          row.instanceId === instance &&
          row.id === id &&
          target &&
          authority &&
          getRuntimeTargetHostId(target) === getRuntimeTargetHostId(authority)
        )
      })
    return matches.length === 1 ? matches[0] : undefined
  }
  const previousChild: WorktreeWithLineage = child
  const previousLineage =
    state.worktreeLineageById[composeWorktreeHostIdentity(child.hostId, child.id)]
  const oldParent = parentRow(
    previousParentInstanceId,
    previousLineage?.parentWorktreeId ?? previousChild.parentWorktreeId ?? undefined
  )
  const newParent = parentRow(lineage?.parentWorktreeInstanceId, lineage?.parentWorktreeId)
  const retainsOldChild =
    oldParent &&
    Object.values(worktreesByRepo)
      .flat()
      .some((row) => {
        const sibling: WorktreeWithLineage = row
        const edge =
          sibling.lineage === undefined
            ? state.worktreeLineageById[composeWorktreeHostIdentity(row.hostId, row.id)]
            : sibling.lineage
        const target = selectedWorktreeTransport(state, row)
        return (
          row !== child &&
          row.id === worktreeId &&
          edge?.parentWorktreeInstanceId === oldParent.instanceId &&
          target &&
          authority &&
          getRuntimeTargetHostId(target) === getRuntimeTargetHostId(authority)
        )
      })
  let nextByRepo = worktreesByRepo
  for (const [repoId, worktrees] of Object.entries(worktreesByRepo)) {
    let repoChanged = false
    const projected = worktrees.map((worktree) => {
      const current: WorktreeWithLineage = worktree
      const hadChild =
        current.childWorktreeIds?.includes(worktreeId) === true && worktree === oldParent
      const isParent = worktree === newParent
      let childWorktreeIds = current.childWorktreeIds
      if (hadChild && !retainsOldChild) {
        childWorktreeIds = childWorktreeIds?.filter((id) => id !== worktreeId)
      }
      if (isParent && !childWorktreeIds?.includes(worktreeId)) {
        childWorktreeIds = [...(childWorktreeIds ?? []), worktreeId]
      }
      if (worktree === child) {
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
    const hostId = child.hostId ?? result.reference.hostId
    const key = composeWorktreeHostIdentity(hostId, worktreeId)
    const next = { ...s.worktreeLineageById }
    if (result.lineage) {
      next[key] = result.lineage
    } else {
      delete next[key]
    }
    const previous: WorktreeWithLineage = child
    const worktreesByRepo = projectLocalWorktreeLineageUpdate(
      s,
      worktreeId,
      result.lineage,
      child,
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
    let worktreesByRepo = s.worktreesByRepo
    for (const child of Object.values(s.worktreesByRepo).flat()) {
      const key = composeWorktreeHostIdentity(child.hostId, child.id)
      if (s.worktreeLineageById[key] === worktreeLineageById[key]) {
        continue
      }
      worktreesByRepo = projectLocalWorktreeLineageUpdate(
        { ...s, worktreesByRepo },
        child.id,
        worktreeLineageById[key] ?? null,
        Object.values(worktreesByRepo)
          .flat()
          .find((row) => row.id === child.id && row.hostId === child.hostId) ?? child,
        s.worktreeLineageById[key]?.parentWorktreeInstanceId
      )
    }
    return { worktreeLineageById, workspaceLineageByChildKey, worktreesByRepo }
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
