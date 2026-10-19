import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { orcadMigrationCutoverFixture } from './orcad-migration-cutover-fixture'
import {
  listOrcadMigrationSourceCutovers,
  removeOrcadMigrationSourceCutover,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import {
  orcadMigrationEditorDraftsSidecarDirectory,
  readOrcadMigrationEditorDraftsSidecar,
  readOrcadMigrationSignedManifestSidecar,
  writeOrcadMigrationEditorDraftsSidecar
} from './orcad-migration-editor-drafts-sidecar'
import { orcadMigrationEditorDraftsDescriptor } from './orcad-migration-editor-drafts-shed'
import { installOrcadMigrationScrollbackRetention } from './orcad-migration-scrollback-retention-wiring'
import { sidecarFiles } from './orcad-migration-editor-drafts-fixture'
import { createHash } from 'node:crypto'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function profile(): string {
  const path = mkdtempSync(join(tmpdir(), 'orcad-drafts-sidecar-'))
  directories.push(path)
  // Retention follows the journal, as it does from startup on.
  installOrcadMigrationScrollbackRetention(path, {
    syncOrcadMigrationScrollbackRetention: () => {}
  })
  return path
}

function body(text: string) {
  const bytes = Buffer.from(text)
  return {
    bytes,
    descriptor: orcadMigrationEditorDraftsDescriptor({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length
    })
  }
}

describe('the shed-drafts sidecar', () => {
  it('reads back exactly what was signed, and refuses different bytes under the same key', () => {
    const path = profile()
    const cutover = orcadMigrationCutoverFixture('m-1', 'ssh-1')
    const drafts = body('{"version":1,"drafts":[]}')
    writeOrcadMigrationEditorDraftsSidecar(path, cutover.manifest, drafts)
    writeOrcadMigrationEditorDraftsSidecar(path, cutover.manifest, drafts)
    expect(readOrcadMigrationEditorDraftsSidecar(path, cutover, drafts.descriptor)).toEqual(
      drafts.bytes
    )
    expect(readOrcadMigrationSignedManifestSidecar(path, cutover)).toEqual(cutover.manifest)
    expect(() =>
      writeOrcadMigrationEditorDraftsSidecar(path, cutover.manifest, body('other'))
    ).toThrow('orcad_migration_editor_drafts_sidecar_conflict')
    expect(
      readOrcadMigrationEditorDraftsSidecar(path, cutover, body('tampered').descriptor)
    ).toBeNull()
  })

  it('is kept while its manifest is pending, and released by a commit or a removed journal', () => {
    const path = profile()
    const cutover = orcadMigrationCutoverFixture('m-1', 'ssh-1')
    writeOrcadMigrationEditorDraftsSidecar(path, cutover.manifest, body('drafts'))
    writeOrcadMigrationSourceCutover(path, cutover)
    expect(sidecarFiles(path)).toHaveLength(2)

    writeOrcadMigrationSourceCutover(path, { ...cutover, phase: 'destination-staged' })
    expect(sidecarFiles(path)).toHaveLength(2)
    // A confirmed commit releases it.
    writeOrcadMigrationSourceCutover(path, { ...cutover, phase: 'destination-committed' })
    expect(sidecarFiles(path)).toEqual([])

    // A confirmed abort removes the journal, which releases it too.
    const other = orcadMigrationCutoverFixture('m-2', 'ssh-2')
    writeOrcadMigrationEditorDraftsSidecar(path, other.manifest, body('drafts'))
    writeOrcadMigrationSourceCutover(path, other)
    expect(sidecarFiles(path)).toHaveLength(2)
    removeOrcadMigrationSourceCutover(path, 'm-2')
    expect(sidecarFiles(path)).toEqual([])
    expect(listOrcadMigrationSourceCutovers(path).map((entry) => entry.migrationId)).toEqual([
      'm-1'
    ])
  })

  it('prunes orphans at startup: a journal-less copy and an unpublished temporary', () => {
    const path = profile()
    const cutover = orcadMigrationCutoverFixture('m-1', 'ssh-1')
    writeOrcadMigrationSourceCutover(path, cutover)
    writeOrcadMigrationEditorDraftsSidecar(path, cutover.manifest, body('kept'))
    const orphan = orcadMigrationCutoverFixture('m-gone', 'ssh-2')
    writeOrcadMigrationEditorDraftsSidecar(path, orphan.manifest, body('orphan'))
    const directory = orcadMigrationEditorDraftsSidecarDirectory(path)
    writeFileSync(join(directory, `m-1.${cutover.manifestSha256}.drafts.123.tmp`), 'partial')

    installOrcadMigrationScrollbackRetention(path, {
      syncOrcadMigrationScrollbackRetention: () => {}
    })
    expect(sidecarFiles(path)).toEqual([
      `m-1.${cutover.manifestSha256}.drafts`,
      `m-1.${cutover.manifestSha256}.manifest.json`
    ])
  })
})
