import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ORCAD_MIGRATION_MANIFEST_VERSION } from '../../../shared/orcad-migration-manifest'
import {
  wslMoveJournalKey,
  type WslMoveCutover,
  type WslMoveCutoverPhase
} from '../../../shared/wsl-move/wsl-move-cutover'
import { computeOrcadMigrationManifestSha256 } from '../../orcad/orcad-migration-manifest-digest'
import { orcadMigrationCutoverJournalDirectory } from '../../ssh/orcad-migration-cutover-journal'
import {
  listWslMoveCutoverChain,
  listWslMoveCutovers,
  removeWslMoveCutover,
  writeWslMoveCutover,
  wslMoveJournalDirectory
} from './wsl-move-cutover-journal'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-journal-'))
})
afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

function cutover(
  migrationId = 'move-1',
  phase: WslMoveCutoverPhase = 'prepared',
  extra: Partial<WslMoveCutover> = {}
): WslMoveCutover {
  const unsigned = {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId,
    createdAt: '2026-10-13T00:00:00.000Z',
    source: {
      kind: 'local-wsl' as const,
      distro: 'Ubuntu',
      scopeRepoIds: ['repo-1'],
      scopeFolderWorkspaceIds: [],
      generation: 1
    },
    payload: {
      repositories: [
        { id: 'repo-1', path: '/home/dev/app', displayName: 'app', badgeColor: '#000', addedAt: 0 }
      ],
      projectGroups: [],
      folderWorkspaces: []
    },
    destinationEnvironmentId: 'wsl:Ubuntu'
  }
  const manifest = { ...unsigned, manifestSha256: computeOrcadMigrationManifestSha256(unsigned) }
  return {
    version: 1,
    migrationId,
    phase,
    startedAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z',
    destinationEnvironmentId: 'wsl:Ubuntu',
    destinationName: 'Ubuntu',
    journalKey: wslMoveJournalKey('Ubuntu'),
    manifestSha256: manifest.manifestSha256,
    provenExitedSessionIds: [],
    rewrittenStores: [],
    manifest,
    ...extra
  }
}

const journalPath = (id: string) => join(wslMoveJournalDirectory(userDataPath), `${id}.json`)

describe('WSL move journal', () => {
  it('round-trips a move in an owner-only file of its own directory', () => {
    writeWslMoveCutover(userDataPath, cutover())
    expect(listWslMoveCutovers(userDataPath)).toEqual([cutover()])
    expect(wslMoveJournalDirectory(userDataPath)).not.toBe(
      orcadMigrationCutoverJournalDirectory(userDataPath)
    )
    if (process.platform !== 'win32') {
      expect(statSync(journalPath('move-1')).mode & 0o077).toBe(0)
    }
    removeWslMoveCutover(userDataPath, 'move-1')
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
  })

  it.each([
    ['corrupt JSON', '{not json'],
    ['another distro key', JSON.stringify({ ...cutover(), journalKey: 'local-wsl:debian' })],
    ['a tampered manifest', JSON.stringify({ ...cutover(), manifestSha256: 'f'.repeat(64) })],
    ['an unknown phase', JSON.stringify({ ...cutover(), phase: 'teleported' })]
  ])('fails closed on %s', (_label, contents) => {
    mkdirSync(wslMoveJournalDirectory(userDataPath), { recursive: true })
    writeFileSync(journalPath('move-1'), contents)
    expect(() => listWslMoveCutovers(userDataPath)).toThrow('stay fenced')
  })

  it('refuses a second move into a distro while the first is in flight', () => {
    writeWslMoveCutover(userDataPath, cutover('move-1', 'quiesced'))
    expect(() =>
      writeWslMoveCutover(
        userDataPath,
        cutover('move-2', 'prepared', { supersedesMigrationId: 'move-1' })
      )
    ).toThrow('wsl_move_already_in_flight')
  })

  it('chains a delta move after a finished one, and only onto the head', () => {
    writeWslMoveCutover(userDataPath, cutover('move-1', 'retained'))
    expect(() => writeWslMoveCutover(userDataPath, cutover('move-2'))).toThrow(
      'wsl_move_must_extend_its_chain'
    )
    writeWslMoveCutover(
      userDataPath,
      cutover('move-2', 'prepared', { supersedesMigrationId: 'move-1' })
    )
    expect(
      listWslMoveCutoverChain(userDataPath, wslMoveJournalKey('ubuntu')).map((c) => c.migrationId)
    ).toEqual(['move-1', 'move-2'])
  })

  it('advances its own record through the phases', () => {
    writeWslMoveCutover(userDataPath, cutover('move-1', 'prepared'))
    writeWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe('source-fenced')
  })
})
