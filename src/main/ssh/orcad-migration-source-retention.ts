/**
 * After commit: a migration keeps its source rows, so a downgraded build still sees the host and
 * its projects and can reach them over its own relay. New builds hide those rows and serve the host
 * from the server. They are never deleted automatically.
 */
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration/orcad-migration-source-cutover'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
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
  await store.runDurableMutation(() => {
    const renamed = renamedDestinationSession(store, cutover)
    if (!renamed) {
      return { value: undefined, persist: false }
    }
    writeDestinationSession(store, cutover, renamed.next)
    return {
      value: undefined,
      rollback: () => writeDestinationSession(store, cutover, renamed.before)
    }
  })
  // Why no baseline here: the source may have changed since the commit (a crash, then an older
  // build); only the fence's pre-commit baseline proves what the server holds.
  const retained = {
    ...readCommittedCutover(userDataPath, migrationId),
    sourceRetainedAt: now().toISOString()
  }
  writeOrcadMigrationSourceCutover(userDataPath, retained)
  return retained
}

/**
 * At startup, before any window reads its sessions: a commit whose retained mark a crash cut off
 * gets its drafts renamed here, since a renderer that booted without them would overwrite them.
 */
export function renameUnretainedOrcadMigrationDrafts(
  userDataPath: string,
  store: Pick<
    OrcadMigrationDraftRenameStore,
    'collectOrcadMigrationSourceDrafts' | 'getWorkspaceSession' | 'setWorkspaceSession'
  >
): void {
  for (const cutover of listOrcadMigrationSourceCutovers(userDataPath)) {
    if (cutover.phase !== 'destination-committed' || cutover.sourceRetainedAt) {
      continue
    }
    try {
      const renamed = renamedDestinationSession(store, cutover)
      if (renamed) {
        writeDestinationSession(store, cutover, renamed.next)
      }
    } catch (error) {
      console.warn('[ssh] Could not rename a committed migration’s unsaved drafts:', error)
    }
  }
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

/** Only files the server partition lacks, so a rerun before the retained mark never clobbers. */
function renamedDestinationSession(
  store: Pick<
    OrcadMigrationDraftRenameStore,
    'collectOrcadMigrationSourceDrafts' | 'getWorkspaceSession'
  >,
  cutover: OrcadMigrationSourceCutover
): { before: WorkspaceSessionState; next: WorkspaceSessionState } | null {
  const before = store.getWorkspaceSession(
    toRuntimeExecutionHostId(cutover.destinationEnvironmentId)
  )
  const next = withRenamedOrcadMigrationDrafts(
    before,
    store.collectOrcadMigrationSourceDrafts(cutover.manifest),
    cutover.destinationEnvironmentId
  )
  return next ? { before, next } : null
}

function writeDestinationSession(
  store: Pick<OrcadMigrationDraftRenameStore, 'setWorkspaceSession'>,
  cutover: OrcadMigrationSourceCutover,
  session: WorkspaceSessionState
): void {
  // Baselined writer: drafts are desktop view state no layout command carries (LayoutEditorFile
  // omits them), and the tabs themselves reach the server only through the manifest.
  store.setWorkspaceSession(session, toRuntimeExecutionHostId(cutover.destinationEnvironmentId))
}
