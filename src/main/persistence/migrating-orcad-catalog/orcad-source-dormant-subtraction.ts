import {
  initializeCanonicalLineage,
  refreshLegacyLineage
} from '../loading-store/canonical-workspace-lineage'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { subtractOrcadSourceWorktreeMetadata } from './orcad-source-worktree-metadata'
import { subtractOrcadMigrationSourceAutomationState } from './orcad-source-automation-subtraction'
import { subtractOrcadMigrationSourceWorkspaceSession } from './orcad-source-workspace-session-subtraction'
import { subtractOrcadMigrationClientState } from './orcad-source-client-subtraction'

/** On a copy of the profile only: what an earlier migration moved, gone from the delta view. */
export function subtractOrcadMigrationSourceDormantState(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  initializeCanonicalLineage(state)
  // By scope, even with no dormant state: a downgraded build may have added some since.
  subtractOrcadSourceWorktreeMetadata(state, manifest)
  subtractOrcadMigrationSourceAutomationState(state, manifest)
  const dormant = manifest.payload.dormantState
  if (!dormant) {
    return
  }
  const movedInstances = dormant.edges?.map((edge) => edge.child.instanceId) ?? [
    ...dormant.worktreeLineage.map((entry) => entry.lineage.worktreeInstanceId),
    ...dormant.workspaceLineage.flatMap((entry) =>
      entry.lineage.childInstanceId ? [entry.lineage.childInstanceId] : []
    )
  ]
  for (const instance of movedInstances) {
    delete state.lineageByChildInstance?.[instance]
  }
  refreshLegacyLineage(state)
  for (const preset of dormant.sparsePresets) {
    const remaining = (state.sparsePresetsByRepo[preset.repoId] ?? []).filter(
      (entry) => entry.id !== preset.id
    )
    if (remaining.length > 0) {
      state.sparsePresetsByRepo[preset.repoId] = remaining
    } else {
      delete state.sparsePresetsByRepo[preset.repoId]
    }
  }
  for (const entry of dormant.retiredWorktreeNames) {
    delete state.retiredWorktreeNamesByRepo?.[entry.repoId]
  }
  subtractOrcadMigrationSourceWorkspaceSession(state, manifest)
  subtractOrcadMigrationClientState(state, manifest)
  // Retain snapshot files: the prior durable profile and rollback evidence can still reference them.
}
