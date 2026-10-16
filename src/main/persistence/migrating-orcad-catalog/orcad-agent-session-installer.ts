/**
 * Destination half of the `agent-session-records` blob: a pre-commit check that each document is
 * one this host can install for a workspace of the migrated catalog, and the post-commit install
 * into this host's chat journal database through its open session store.
 */
import { createHash } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { ORCAD_MIGRATION_BLOB_KIND_CONTRACTS } from '../../../shared/orcad-migration-blob-transfer'
import { syncDirectoryDurablySync } from '../../durable-file-write'
import {
  parseOrcadMigrationAgentSessionDocument,
  type OrcadMigrationAgentSessionDocument
} from './orcad-migration-agent-session-format'
import {
  getOrcadMigrationReceivedBlobPath,
  listOrcadMigrationReceivedBlobNames
} from './orcad-migration-blob-staging'
import {
  orcadMigrationCatalogOwnsWorktree,
  type OrcadMigrationWorktreeCatalog
} from './orcad-migration-catalog-worktree-ownership'
import type { OrcadMigrationRequestIdentity } from './orcad-migration-staged-file'

/** This host's chat journal, as the runtime's open session store reaches it. */
export type OrcadMigrationAgentSessionJournal = {
  /** Throws when this host already holds the session with other content. */
  assertInstallable: (document: OrcadMigrationAgentSessionDocument) => void
  /**
   * Every row in one journal transaction, marked installed by `sha256`. False when it already was,
   * or when identical rows were already here; throws on a conflict and leaves the journal as it was.
   */
  install: (document: OrcadMigrationAgentSessionDocument, sha256: string) => boolean
}

/**
 * Throws unless the staged file is a session document this host can install for a workspace the
 * catalog moves. Without a journal (the runtime could not open it) the conflict check waits for the
 * install, which refuses the same way and keeps the blob.
 */
export function assertOrcadMigrationAgentSessionValid(
  key: string,
  path: string,
  catalog: OrcadMigrationWorktreeCatalog,
  journal: OrcadMigrationAgentSessionJournal | undefined
): void {
  const document = parseOrcadMigrationAgentSessionDocument(key, readFileSync(path))
  // Refused, not dropped: only a sender bug names a workspace outside the catalog.
  if (!orcadMigrationCatalogOwnsWorktree(catalog, document.record.location.workspaceId)) {
    throw new Error('orcad_migration_agent_session_workspace_not_migrated')
  }
  journal?.assertInstallable(document)
}

export type OrcadAgentSessionInstall = {
  migration: OrcadMigrationRequestIdentity
  root: string
  journal: OrcadMigrationAgentSessionJournal
}

/**
 * Installs every received session, then deletes its blob. A failure (a conflict, an unreadable
 * file, a journal that will not write) keeps that blob for the next retry and is rethrown once the
 * others had their turn: a session is never dropped.
 */
export function installOrcadMigrationAgentSessions(install: OrcadAgentSessionInstall): void {
  let firstError: unknown = null
  for (const key of listOrcadMigrationReceivedBlobNames(
    install.root,
    install.migration,
    'agent-session-records'
  )) {
    if (!ORCAD_MIGRATION_BLOB_KIND_CONTRACTS['agent-session-records'].key.test(key)) {
      continue
    }
    try {
      installOne(install, key)
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError !== null) {
    throw firstError
  }
}

function installOne(install: OrcadAgentSessionInstall, key: string): void {
  const path = getOrcadMigrationReceivedBlobPath(install.root, install.migration, {
    blobKind: 'agent-session-records',
    key
  })
  const bytes = readFileSync(path)
  const document = parseOrcadMigrationAgentSessionDocument(key, bytes)
  install.journal.install(document, createHash('sha256').update(bytes).digest('hex'))
  rmSync(path, { force: true })
  syncDirectoryDurablySync(dirname(path))
}

/** Whether any committed migration still holds a session waiting to be installed. */
export function hasPendingOrcadMigrationAgentSessions(
  root: string,
  migrations: readonly OrcadMigrationRequestIdentity[]
): boolean {
  return migrations.some(
    (migration) =>
      listOrcadMigrationReceivedBlobNames(root, migration, 'agent-session-records').length > 0
  )
}
