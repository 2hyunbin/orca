import { resolveSelectedWorktree } from '@/lib/selected-worktree-reference'
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
import { getRuntimeTargetHostId } from '../../../../runtime/runtime-client-target'

// Why: this runs inside a catch, so letting the refresh reject would replace the failure it recovers from.
async function refreshWorktreeLineageBestEffort(
  ownerTarget: RuntimeClientTarget,
  set: WorktreeSliceSet,
  get: WorktreeSliceGet,
  refreshRows = false
): Promise<void> {
  try {
    if (refreshRows) {
      await get().fetchAllWorktrees({ visibilityOwnerHostId: getRuntimeTargetHostId(ownerTarget) })
    }
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
  return async (reference, args) => {
    const state = get()
    const child = resolveSelectedWorktree(state, reference)
    const parent = resolveSelectedWorktree(state, args.parent)
    if (
      !child ||
      (!args.noParent &&
        (!parent || getRuntimeTargetHostId(child.target) !== getRuntimeTargetHostId(parent.target)))
    ) {
      throw new Error('selector_not_found')
    }
    const ownerTarget = child.target
    try {
      const result = await setWorktreeLineageForRuntime(
        ownerTarget,
        reference,
        {
          ...(parent ? { parentWorktreeId: parent.selector } : {}),
          noParent: args.noParent
        },
        child.selector
      )
      if (reference.kind === 'legacy') {
        await refreshWorktreeLineageBestEffort(ownerTarget, set, get, true)
      } else {
        if (args.parent && !resolveSelectedWorktree(get(), args.parent)) {
          throw new Error('selector_not_found')
        }
        applyWorktreeLineageUpdate(set, result)
      }
    } catch (err) {
      console.error('Failed to update worktree lineage:', err)
      await refreshWorktreeLineageBestEffort(ownerTarget, set, get, reference.kind === 'legacy')
      throw err
    }
  }
}

export function createAssignWorktreeParent(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['assignWorktreeParent'] {
  return createUpdateWorktreeLineage(set, get)
}
