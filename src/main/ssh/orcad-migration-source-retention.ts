/**
 * After commit: a migration keeps its source rows, so a downgraded build still sees the host and
 * its projects and can reach them over its own relay. New builds hide those rows and serve the host
 * from the server. They are never deleted automatically.
 */
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration/orcad-migration-source-cutover'
import type { Store } from '../persistence'
import { withRenamedOrcadMigrationDrafts } from '../persistence/migrating-orcad-catalog/orcad-source-draft-rename'
import {
  listOrcadMigrationSourceCutovers,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'

export type OrcadMigrationDraftRenameStore = Pick<
  Store,
  | 'collectOrcadMigrationSourceDrafts'
  | 'getWorkspaceSession'
  | 'runDurableMutation'
  | 'setWorkspaceSession'
>

/**
 * Marks a committed migration as finished for this build while its source rows stay. Its unsaved
 * drafts are renamed to the server first, durably, so the retained mark proves they were.
 */
export async function retainOrcadMigrationSource(
  userDataPath: string,
  migrationId: string,
  store: OrcadMigrationDraftRenameStore,
  now: () => Date = () => new Date()
): Promise<OrcadMigrationSourceCutover> {
  const cutover = readCommittedCutover(userDataPath, migrationId)
  if (cutover.sourceRetainedAt) {
    return cutover
  }
  await renameOrcadMigrationDraftsToDestination(store, cutover)
  // Why no baseline here: the source may have changed since the commit (a crash, then an older
  // build); only the fence's pre-commit baseline proves what the server holds.
  const retained = {
    ...readCommittedCutover(userDataPath, migrationId),
    sourceRetainedAt: now().toISOString()
  }
  writeOrcadMigrationSourceCutover(userDataPath, retained)
  return retained
}

function readCommittedCutover(userDataPath: string, migrationId: string) {
  const cutover = listOrcadMigrationSourceCutovers(userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  if (!cutover || cutover.phase !== 'destination-committed') {
    throw new Error('orcad_migration_retain_before_commit')
  }
  return cutover
}

/** Runs once per migration, before its retained mark: a later run would revive discarded drafts. */
async function renameOrcadMigrationDraftsToDestination(
  store: OrcadMigrationDraftRenameStore,
  cutover: OrcadMigrationSourceCutover
): Promise<void> {
  const hostId = toRuntimeExecutionHostId(cutover.destinationEnvironmentId)
  await store.runDurableMutation(() => {
    const before = store.getWorkspaceSession(hostId)
    const next = withRenamedOrcadMigrationDrafts(
      before,
      store.collectOrcadMigrationSourceDrafts(cutover.manifest).drafts
    )
    if (!next) {
      return { value: undefined, persist: false }
    }
    store.setWorkspaceSession(next, hostId)
    return { value: undefined, rollback: () => store.setWorkspaceSession(before, hostId) }
  })
}
