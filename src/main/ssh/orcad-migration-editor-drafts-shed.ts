/**
 * Moving unsaved editor buffers out of a migration's signed manifest into its `editor-drafts`
 * blob, so a session with large drafts still fits the manifest cap. Runs after the path rewrite:
 * the blob names entries by the destination paths the manifest carries.
 */
import { createHash } from 'node:crypto'
import { translateMain } from '../i18n/main-i18n'
import {
  ORCAD_MIGRATION_BLOB_KIND_CONTRACTS,
  type OrcadMigrationBlobDescriptor
} from '../../shared/orcad-migration/orcad-migration-blob-transfer'
import {
  MAX_ORCAD_MIGRATION_EDITOR_DRAFTS_BYTES,
  ORCAD_MIGRATION_EDITOR_DRAFTS_KEY,
  ORCAD_MIGRATION_EDITOR_DRAFTS_VERSION,
  type OrcadMigrationEditorDraft,
  type OrcadMigrationEditorDraftsDeclaration,
  type OrcadMigrationEditorDraftsDocument
} from '../../shared/orcad-migration/orcad-migration-editor-drafts'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationManifest
} from '../../shared/orcad-migration/orcad-migration-manifest'

export const ORCAD_MIGRATION_EDITOR_DRAFTS_CAPABILITY =
  ORCAD_MIGRATION_BLOB_KIND_CONTRACTS['editor-drafts'].capability

/** The bytes the manifest's `editorDraftsBlob` declares, exactly as hashed. */
export type OrcadMigrationEditorDraftsBody = {
  descriptor: OrcadMigrationBlobDescriptor
  bytes: Buffer
}

export function orcadMigrationEditorDraftsDescriptor(
  declaration: Pick<OrcadMigrationEditorDraftsDeclaration, 'sha256' | 'byteLength'>
): OrcadMigrationBlobDescriptor {
  return {
    blobKind: 'editor-drafts',
    key: ORCAD_MIGRATION_EDITOR_DRAFTS_KEY,
    sha256: declaration.sha256,
    byteLength: declaration.byteLength
  }
}

export function shedOrcadMigrationEditorDrafts(payload: OrcadMigrationCatalogPayload): {
  payload: OrcadMigrationCatalogPayload
  body: OrcadMigrationEditorDraftsBody | null
} {
  if (!payload.dormantState?.workspaceSession?.openFilesByWorktree) {
    return { payload, body: null }
  }
  // A copy edited in place, as the path rewrite does: the source session is never touched.
  const shed = structuredClone(payload)
  const dormant = shed.dormantState
  if (!dormant) {
    return { payload, body: null }
  }
  const drafts: OrcadMigrationEditorDraft[] = []
  for (const [worktreeKey, files] of Object.entries(
    dormant.workspaceSession?.openFilesByWorktree ?? {}
  )) {
    for (const file of files) {
      // The declaration names an entry by path, so a path open twice keeps its draft inline.
      const unique = files.filter((other) => other.filePath === file.filePath).length === 1
      if (file.dirtyDraftContent !== undefined && unique) {
        drafts.push({ worktreeKey, filePath: file.filePath, content: file.dirtyDraftContent })
        delete file.dirtyDraftContent
      }
    }
  }
  if (drafts.length === 0) {
    return { payload, body: null }
  }
  const document: OrcadMigrationEditorDraftsDocument = {
    version: ORCAD_MIGRATION_EDITOR_DRAFTS_VERSION,
    drafts
  }
  const bytes = Buffer.from(JSON.stringify(document), 'utf8')
  if (bytes.byteLength > MAX_ORCAD_MIGRATION_EDITOR_DRAFTS_BYTES) {
    throw new Error(
      `orcad_migration_editor_drafts_too_large:${translateMain(
        'managedServerMigration.draftsTooLarge',
        'Unsaved changes on this host are larger than {{limit}} MB, so they stay on this computer. Save or discard some of them, then reconnect: {{files}}',
        {
          limit: MAX_ORCAD_MIGRATION_EDITOR_DRAFTS_BYTES / (1024 * 1024),
          files: drafts.map((draft) => draft.filePath).join(', ')
        }
      )}`
    )
  }
  const declaration: OrcadMigrationEditorDraftsDeclaration = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
    entries: drafts.map(({ worktreeKey, filePath }) => ({ worktreeKey, filePath }))
  }
  dormant.editorDraftsBlob = declaration
  return {
    payload: shed,
    body: { descriptor: orcadMigrationEditorDraftsDescriptor(declaration), bytes }
  }
}

/** For comparing or scoping only: drafts never count there, so their size must not either. */
export function omitOrcadMigrationEditorDrafts(
  payload: OrcadMigrationCatalogPayload
): OrcadMigrationCatalogPayload {
  if (!payload.dormantState?.workspaceSession?.openFilesByWorktree) {
    return payload
  }
  const omitted = structuredClone(payload)
  for (const files of Object.values(
    omitted.dormantState?.workspaceSession?.openFilesByWorktree ?? {}
  )) {
    for (const file of files) {
      delete file.dirtyDraftContent
    }
  }
  return omitted
}

/** Every unsaved buffer the payload still carries inline, by path: what an oversize names. */
export function inlineOrcadMigrationEditorDraftPaths(payload: OrcadMigrationCatalogPayload): {
  paths: string[]
  bytes: number
} {
  const files = Object.values(
    payload.dormantState?.workspaceSession?.openFilesByWorktree ?? {}
  ).flat()
  const drafts = files.filter((file) => file.dirtyDraftContent !== undefined)
  return {
    paths: drafts.map((file) => file.filePath),
    bytes: drafts.reduce(
      (total, file) => total + Buffer.byteLength(file.dirtyDraftContent ?? '', 'utf8'),
      0
    )
  }
}

/**
 * Blob kinds the signed manifest itself declares. An older parser drops `editorDraftsBlob` yet still
 * passes the raw-digest check, so staging or committing there would land the session without its
 * drafts; state and abort stay open, since recovery asks and aborts by the same signed manifest.
 */
export function declaredOrcadMigrationBlobKinds(
  manifest: OrcadMigrationManifest,
  operation: 'abort' | 'commit' | 'stage' | 'state'
): Pick<OrcadMigrationBlobDescriptor, 'blobKind'>[] {
  return (operation === 'stage' || operation === 'commit') &&
    manifest.payload.dormantState?.editorDraftsBlob
    ? [{ blobKind: 'editor-drafts' }]
    : []
}
