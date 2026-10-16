import type { LineageEdge, WorkspaceLineage, WorktreeLineage } from './lineage-types'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../workspace-scope'

export function workspaceLineageToEdge(lineage: WorkspaceLineage): LineageEdge | undefined {
  const { childWorkspaceKey, childInstanceId, parentWorkspaceKey, parentInstanceId, ...details } =
    lineage
  if (!childInstanceId) {
    return undefined
  }
  return {
    ...details,
    child: { instanceId: childInstanceId, locator: childWorkspaceKey },
    parent: {
      locator: parentWorkspaceKey,
      ...(parentInstanceId ? { instanceId: parentInstanceId } : {})
    }
  }
}

export function worktreeLineageToEdge(lineage: WorktreeLineage): LineageEdge | undefined {
  const { worktreeId, worktreeInstanceId, parentWorktreeId, parentWorktreeInstanceId, ...details } =
    lineage
  if (!worktreeInstanceId) {
    return undefined
  }
  return {
    ...details,
    child: { instanceId: worktreeInstanceId, locator: worktreeWorkspaceKey(worktreeId) },
    parent: {
      instanceId: parentWorktreeInstanceId,
      locator: worktreeWorkspaceKey(parentWorktreeId)
    }
  }
}

export function edgeToWorkspaceLineage(edge: LineageEdge): WorkspaceLineage {
  const { child, parent, ...details } = edge
  return {
    ...details,
    childWorkspaceKey: child.locator,
    childInstanceId: child.instanceId,
    parentWorkspaceKey: parent.locator,
    parentInstanceId: parent.instanceId ?? null
  }
}

export function edgeToWorktreeLineage(edge: LineageEdge): WorktreeLineage | undefined {
  const child = parseWorkspaceKey(edge.child.locator)
  const parent = parseWorkspaceKey(edge.parent.locator)
  if (child?.type !== 'worktree' || parent?.type !== 'worktree' || !edge.parent.instanceId) {
    return undefined
  }
  const { child: _child, parent: _parent, ...details } = edge
  return {
    ...details,
    worktreeId: child.worktreeId,
    worktreeInstanceId: edge.child.instanceId,
    parentWorktreeId: parent.worktreeId,
    parentWorktreeInstanceId: edge.parent.instanceId
  }
}
