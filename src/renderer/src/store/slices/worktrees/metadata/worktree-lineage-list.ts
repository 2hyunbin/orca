import {
  edgeToWorktreeLineage,
  edgeToWorkspaceLineage
} from '../../../../../../shared/worktree/lineage-edge'
import { WORKTREE_LINEAGE_EDGES_RUNTIME_CAPABILITY } from '../../../../../../shared/runtime-capability-constants'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type {
  LineageEdge,
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../../shared/worktree/lineage-types'
import {
  callRuntimeRpc,
  runtimeEnvironmentSupportsCapability
} from '../../../../runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { getRuntimeTargetHostId } from '../../../../runtime/runtime-client-target'
import type { BackgroundRuntimeRefreshOptions } from '../listing/worktree-slice-types'

export async function listWorktreeLineageForRuntime(
  target: RuntimeClientTarget,
  options: BackgroundRuntimeRefreshOptions = {}
): Promise<{
  worktreeLineageById: Readonly<Record<string, WorktreeLineage>>
  workspaceLineageByChildKey: Readonly<Record<string, WorkspaceLineage>>
}> {
  type LineageListResponse = {
    edges?: LineageEdge[]
    lineage?: Record<string, WorktreeLineage>
    workspaceLineage?: Record<string, WorkspaceLineage>
  }
  const isLineageListResponse = (
    value: Record<string, WorktreeLineage> | LineageListResponse
  ): value is LineageListResponse =>
    Object.hasOwn(value, 'lineage') || Object.hasOwn(value, 'workspaceLineage')
  const normalizeLineageResponse = (
    value: Record<string, WorktreeLineage> | LineageListResponse
  ) =>
    isLineageListResponse(value)
      ? {
          worktreeLineageById: value.lineage ?? {},
          workspaceLineageByChildKey: value.workspaceLineage ?? {}
        }
      : {
          worktreeLineageById: value,
          workspaceLineageByChildKey: {}
        }
  const response: LineageListResponse =
    target.kind === 'local'
      ? await window.api.worktrees.listLineage()
      : await callRuntimeRpc<LineageListResponse>(target, 'worktree.lineageList', undefined, {
          timeoutMs: 15_000,
          reuseRecentCompatibilityFailure: options.reuseRecentCompatibilityFailure
        })
  if (
    response.edges &&
    (target.kind === 'local' ||
      (await runtimeEnvironmentSupportsCapability(
        target.environmentId,
        WORKTREE_LINEAGE_EDGES_RUNTIME_CAPABILITY
      )))
  ) {
    const worktreeLineageById: Record<string, WorktreeLineage> = {}
    const workspaceLineageByChildKey: Record<string, WorkspaceLineage> = {}
    for (const edge of response.edges) {
      const child = parseWorkspaceKey(edge.child.locator)
      const host =
        target.kind === 'environment' ? getRuntimeTargetHostId(target) : edge.child.hostId
      const lineage = edgeToWorktreeLineage(edge)
      if (child?.type === 'worktree' && lineage) {
        worktreeLineageById[composeWorktreeHostIdentity(host, child.worktreeId)] = lineage
      }
      workspaceLineageByChildKey[composeWorktreeHostIdentity(host, edge.child.locator)] =
        edgeToWorkspaceLineage(edge)
    }
    return { worktreeLineageById, workspaceLineageByChildKey }
  }
  return normalizeLineageResponse(response)
}
