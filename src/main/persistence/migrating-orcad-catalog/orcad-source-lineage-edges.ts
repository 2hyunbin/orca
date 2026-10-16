import {
  ownedLineageEdges,
  projectOwnedLineageEdge,
  savedLineageOwners
} from '../loading-store/canonical-workspace-lineage'
import type { LineageEdge } from '../../../shared/worktree/lineage-types'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import {
  worktreeLineageToEdge,
  workspaceLineageToEdge,
  edgeToWorktreeLineage,
  edgeToWorkspaceLineage
} from '../../../shared/worktree/lineage-edge'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { OrcadMigrationDormantStatePayload } from '../../../shared/orcad-migration-manifest'
import {
  orcadMigrationOwnerMatchesScope,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'

export function collectOrcadSourceLineageEdges(
  state: PersistedState,
  scope: OrcadMigrationSourceScope,
  worktreeLineage: OrcadMigrationDormantStatePayload['worktreeLineage'],
  workspaceLineage: OrcadMigrationDormantStatePayload['workspaceLineage'],
  owners = savedLineageOwners(state)
) {
  const candidates =
    state.lineageByChildInstance === undefined
      ? [
          ...worktreeLineage.flatMap((row) => worktreeLineageToEdge(row.lineage) ?? []),
          ...workspaceLineage.flatMap((row) => workspaceLineageToEdge(row.lineage) ?? [])
        ]
      : ownedLineageEdges(state, owners)
  const edges = [
    ...new Map(
      candidates.flatMap((edge) => {
        const projected = orcadSourceLineageInScope(state, scope, edge, owners)
        return projected ? [[projected.child.instanceId, projected] as const] : []
      })
    ).values()
  ]
  for (const edge of edges) {
    const child = parseWorkspaceKey(edge.child.locator)
    if (child?.type !== 'worktree') {
      continue
    }
    const sourceKey = composeWorktreeHostIdentity(edge.child.hostId, child.worktreeId)
    const projected = edgeToWorktreeLineage(edge)
    const oldWorktree = worktreeLineage.findIndex((entry) => entry.worktreeId === child.worktreeId)
    if (oldWorktree !== -1) {
      worktreeLineage.splice(oldWorktree, 1)
    }
    if (projected) {
      worktreeLineage.push({ sourceKey, worktreeId: child.worktreeId, lineage: projected })
    }
    const oldWorkspace = workspaceLineage.findIndex(
      (entry) => entry.childWorkspaceKey === edge.child.locator
    )
    if (oldWorkspace !== -1) {
      workspaceLineage.splice(oldWorkspace, 1)
    }
    workspaceLineage.push({
      sourceKey: composeWorktreeHostIdentity(edge.child.hostId, edge.child.locator),
      childWorkspaceKey: edge.child.locator,
      lineage: {
        ...edgeToWorkspaceLineage(edge),
        childInstanceId: edge.child.instanceId,
        parentInstanceId: edge.parent.instanceId ?? null
      }
    })
  }
  return edges
}

export function orcadSourceLineageInScope(
  state: PersistedState,
  scope: OrcadMigrationSourceScope,
  edge: LineageEdge | undefined,
  owners: ReturnType<typeof savedLineageOwners>
): LineageEdge | undefined {
  const projected = edge && projectOwnedLineageEdge(state, edge, owners)
  if (!projected) {
    return undefined
  }
  const parent = projected.parent.instanceId ? owners.get(projected.parent.instanceId) : undefined
  if (projected.parent.instanceId && !parent) {
    return undefined
  }
  const folder = parseWorkspaceKey(projected.parent.locator)
  if (
    !projected.parent.instanceId &&
    (folder?.type !== 'folder' ||
      !state.folderWorkspaces.some((row) => row.id === folder.folderWorkspaceId))
  ) {
    return undefined
  }
  return orcadMigrationOwnerMatchesScope(projected.child.locator, scope, projected.child.hostId) &&
    orcadMigrationOwnerMatchesScope(projected.parent.locator, scope, parent?.hostId)
    ? projected
    : undefined
}
