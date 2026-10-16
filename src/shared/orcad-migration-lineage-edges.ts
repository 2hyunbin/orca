import type { LineageEdge } from './worktree/lineage-types'
import { workspaceLineageToEdge } from './worktree/lineage-edge'
import { parseWorkspaceLineageEntry } from './orcad-migration-dormant-state-entry-validation'
import { requiredRecord, requiredString } from './orcad-migration-dormant-value-validation'

export function parseOrcadLineageEdge(value: unknown): LineageEdge {
  const record = requiredRecord(value, 'orcad_migration_lineage_edge_invalid')
  const child = requiredRecord(record.child, 'orcad_migration_lineage_child_invalid')
  const parent = requiredRecord(record.parent, 'orcad_migration_lineage_parent_invalid')
  const instanceId = requiredString(child.instanceId, 'orcad_migration_lineage_instance_invalid')
  const lineage = parseWorkspaceLineageEntry({
    sourceKey: instanceId,
    childWorkspaceKey: child.locator,
    lineage: {
      ...record,
      childWorkspaceKey: child.locator,
      childInstanceId: instanceId,
      parentWorkspaceKey: parent.locator,
      parentInstanceId: parent.instanceId
    }
  }).lineage
  const edge = workspaceLineageToEdge(lineage)
  if (!edge) {
    throw new Error('orcad_migration_lineage_instance_invalid')
  }
  return { ...edge, child: { ...edge.child, hostId: 'local' } }
}
