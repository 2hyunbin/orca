import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import {
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
  workspaceLineage: OrcadMigrationDormantStatePayload['workspaceLineage']
) {
  const edges = Object.values(state.lineageByChildInstance ?? {}).filter(
    (edge) =>
      edge.child.hostId &&
      orcadMigrationOwnerMatchesScope(
        composeWorktreeHostIdentity(edge.child.hostId, edge.child.locator),
        scope
      )
  )
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
