import { lineageStoreKeyForRow } from '../../../../../../shared/resolved-worktree-lineage'
import { getLineageInputs } from '../../../../components/sidebar/visible-worktree-indexes'
import { isWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { ParentWorktreeRef } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { parseExecutionHostId } from '../../../../../../shared/execution-host'
import { runtimeTargetForOwnerEnvironment } from '../../../../runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import {
  applyWorktreeLineageUpdate,
  refreshWorktreeLineageForTarget,
  setWorktreeLineageForRuntime
} from './worktree-lineage-refresh'
import { hostRouteForWorktreeOwner } from '../listing/worktree-owner-target'

function selectedRow(rows: ReadonlyMap<string, Worktree>, selection: string): Worktree | undefined {
  const exact = rows.get(selection)
  if (exact) {
    return exact
  }
  const matches = isWorktreeHostIdentity(selection)
    ? []
    : [...rows.values()].filter((row) => row.id === selection)
  if (matches.length === 1) {
    return matches[0]
  }
  if (isWorktreeHostIdentity(selection) || matches.length > 1) {
    throw new Error('The selected workspace changed. Select it again.')
  }
  return undefined
}

function withParentReference(
  get: WorktreeSliceGet,
  worktreeId: string,
  args: { parentWorktreeId?: string; noParent?: boolean }
): typeof args & { parentWorktreeRef?: ParentWorktreeRef } {
  if (!args.parentWorktreeId || args.noParent) {
    return args
  }
  const rows = getLineageInputs(get()).worktreeMap
  const child = selectedRow(rows, worktreeId)
  const parent = selectedRow(rows, args.parentWorktreeId)
  if (
    !child ||
    !parent?.instanceId ||
    (child.hostId === parent.hostId &&
      lineageStoreKeyForRow(child) === lineageStoreKeyForRow(parent))
  ) {
    return {
      ...args,
      parentWorktreeId: parent?.id ?? args.parentWorktreeId
    }
  }
  return {
    ...args,
    parentWorktreeId: parent.id,
    parentWorktreeRef: {
      worktreeId: parent.id,
      instanceId: parent.instanceId,
      external: lineageStoreKeyForRow(child) !== lineageStoreKeyForRow(parent)
    }
  }
}

// Why: this runs inside a catch, so letting the refresh reject would replace the failure it recovers from.
async function refreshWorktreeLineageBestEffort(
  ownerTarget: RuntimeClientTarget,
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): Promise<void> {
  try {
    await refreshWorktreeLineageForTarget(ownerTarget, set, get)
  } catch (err) {
    console.error('Failed to refresh worktree lineage after a failed write:', err)
  }
}

export function createFetchWorktreeLineage(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['fetchWorktreeLineage'] {
  return async (options) => {
    try {
      // Why: lineage is a focused-host refresh; host-merge so other hosts' fetched lineage is preserved.
      const ownerSettings = get().settings
      const parsedHost = options?.executionHostId
        ? parseExecutionHostId(options.executionHostId)
        : null
      const activeRuntimeEnvironmentId =
        parsedHost?.kind === 'runtime'
          ? parsedHost.environmentId
          : parsedHost || options?.forceLocalOwner
            ? null
            : ownerSettings?.activeRuntimeEnvironmentId
      await refreshWorktreeLineageForTarget(
        runtimeTargetForOwnerEnvironment(activeRuntimeEnvironmentId ?? null),
        set,
        get,
        {
          reuseRecentCompatibilityFailure: true
        }
      )
    } catch (err) {
      console.error('Failed to fetch worktree lineage:', err)
    }
  }
}

export function createUpdateWorktreeLineage(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['updateWorktreeLineage'] {
  return async (worktreeId, args) => {
    // Why: an unresolvable owner route (ambiguous or missing) rejects rather than skipping — this is a
    // user-initiated action, and both callers toast the failure. Don't swallow it into a silent no-op.
    const child = selectedRow(getLineageInputs(get()).worktreeMap, worktreeId)
    const id = child?.id ?? worktreeId
    const ownerRoute = hostRouteForWorktreeOwner(get(), id, child?.hostId)
    try {
      applyWorktreeLineageUpdate(
        set,
        id,
        await setWorktreeLineageForRuntime(
          ownerRoute,
          id,
          withParentReference(get, worktreeId, args)
        )
      )
    } catch (err) {
      console.error('Failed to update worktree lineage:', err)
      await refreshWorktreeLineageBestEffort(ownerRoute.target, set, get)
      throw err
    }
  }
}

export function createAssignWorktreeParent(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['assignWorktreeParent'] {
  return async (worktreeId, args) => {
    const child = selectedRow(getLineageInputs(get()).worktreeMap, worktreeId)
    const id = child?.id ?? worktreeId
    const ownerRoute = hostRouteForWorktreeOwner(get(), id, child?.hostId)
    try {
      applyWorktreeLineageUpdate(
        set,
        id,
        await setWorktreeLineageForRuntime(
          ownerRoute,
          id,
          withParentReference(get, worktreeId, args)
        )
      )
    } catch (err) {
      console.error('Failed to assign worktree parent:', err)
      // Unlike the update path this rethrows, so the recovery refresh must not mask the original cause.
      await refreshWorktreeLineageBestEffort(ownerRoute.target, set, get)
      throw err
    }
  }
}
