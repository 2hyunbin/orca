import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireProfileStateMaintenance } from './profile-state-access'
import { bootstrapProfileStateAuthority } from './profile-state-authority-bootstrap'
import {
  createProfileStateDatabaseBackupId,
  profileStateDatabaseBackupPath
} from './profile-state-backup-path'
import { writeProfileStateBackup } from './profile-state-backup-job'
import { openWritableProfileStateDatabase } from './profile-state-database'
import { writeProfileStateDomains } from './profile-state-domain-writes'
import { migrateProfileStateToSqlite } from './profile-state-migration'
import { rollbackProfileState } from './profile-state-recovery-command'
import { ProfileStateRecoveryRequiredError } from './profile-state-recovery-required'
import { formatProfileStateStartupFailure } from './profile-state-startup-failure'
import type { ProfileStateRecoverySelector } from '../../../shared/profile-state-recovery-command'

const roots: string[] = []
const profileId = 'section-repair'

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** A profile with a backup at revision 1, then newer saves to two sections at revision 2. */
async function profileWithNewerSaves() {
  const root = mkdtempSync(join(tmpdir(), 'orca-section-repair-'))
  roots.push(root)
  const directory = join(root, 'profiles', profileId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(root, 'orca-profile-index.json'),
    JSON.stringify({ activeProfileId: profileId, profiles: [{ id: profileId }] })
  )
  const dataFile = join(directory, 'orca-data.json')
  const databaseFile = join(directory, 'profile-state.db')
  const initialJson = JSON.stringify({
    repos: ['a'],
    ui: { width: 1 },
    automationRuns: [{ id: 'r1', n: 1 }]
  })
  writeFileSync(dataFile, initialJson)
  migrateProfileStateToSqlite({
    dataFile,
    databaseFile,
    profileId,
    expectedLegacyJson: initialJson,
    serializedState: initialJson
  }).authority.close()
  const backupId = createProfileStateDatabaseBackupId(Date.now() - 60_000)
  await writeProfileStateBackup({
    databasePath: databaseFile,
    profileId,
    targetPath: profileStateDatabaseBackupPath(databaseFile, backupId)
  })
  withDatabase(databaseFile, (db) =>
    writeProfileStateDomains(db, {
      expectedRevision: 1,
      replacements: [
        { domain: 'repos', payload: JSON.stringify(['a', 'b']) },
        { domain: 'ui', payload: JSON.stringify({ width: 2 }) }
      ]
    })
  )
  return { root, dataFile, databaseFile, profileId, backupId }
}

function withDatabase<T>(
  databaseFile: string,
  write: (db: ReturnType<typeof openWritableProfileStateDatabase>['db']) => T
): T {
  const opened = openWritableProfileStateDatabase(databaseFile, profileId)
  try {
    return write(opened.db)
  } finally {
    opened.db.close()
  }
}

function startupFailure(profile: Awaited<ReturnType<typeof profileWithNewerSaves>>) {
  try {
    bootstrapProfileStateAuthority(profile).authority?.close()
  } catch (error) {
    if (error instanceof ProfileStateRecoveryRequiredError) {
      return error
    }
    throw error
  }
  throw new Error('expected the profile to need recovery')
}

function rollback(
  profile: Awaited<ReturnType<typeof profileWithNewerSaves>>,
  selector: ProfileStateRecoverySelector
) {
  const maintenance = acquireProfileStateMaintenance(profile.root)
  try {
    return rollbackProfileState(profile.root, selector, maintenance)
  } finally {
    maintenance.release()
  }
}

describe('repairing damaged profile-state sections', () => {
  // Each damage keeps the stored hash of a value the backup also holds, so no "unchanged" shortcut may skip it.
  it.each([
    {
      section: 'repos',
      damage:
        'UPDATE profile_state_documents SET payload = \'["a","b","c"]\' WHERE domain = \'repos\'',
      repaired: { repos: ['a'], ui: { width: 2 }, automationRuns: [{ id: 'r1', n: 1 }] }
    },
    {
      section: 'automationRuns',
      damage: `UPDATE profile_state_automation_runs SET payload = '{"id":"r1","n":9}' WHERE run_id = 'r1'`,
      repaired: { repos: ['a', 'b'], ui: { width: 2 }, automationRuns: [{ id: 'r1', n: 1 }] }
    }
  ])(
    'replaces only damaged $section from a backup and keeps newer intact sections',
    async ({ section, damage, repaired }) => {
      const profile = await profileWithNewerSaves()
      withDatabase(profile.databaseFile, (db) => db.exec(damage))
      const damagedBytes = readFileSync(profile.databaseFile)

      const failure = startupFailure(profile)
      expect(failure.repairableSections).toEqual([
        { domain: section, backupId: profile.backupId, backupCreatedAtMs: expect.any(Number) }
      ])
      expect(formatProfileStateStartupFailure(failure)).toContain(
        `orca profile state rollback --repair --profile-id ${profileId}`
      )

      expect(() =>
        rollback(profile, { kind: 'repair', sections: [{ domain: section, backupId: null }] })
      ).toThrow('changed since you chose')
      expect(readFileSync(profile.databaseFile)).toEqual(damagedBytes)

      const result = rollback(profile, {
        kind: 'repair',
        sections: [{ domain: section, backupId: profile.backupId }]
      })
      expect(result).toMatchObject({ storage: 'sqlite', revision: 3, removedDatabaseFiles: [] })
      expect(readFileSync(join(result.quarantineDirectory, 'profile-state.db'))).toEqual(
        damagedBytes
      )

      const reopened = bootstrapProfileStateAuthority(profile)
      try {
        expect(JSON.parse(reopened.authority?.readSerializedState() ?? 'null')).toEqual(repaired)
      } finally {
        reopened.authority?.close()
      }
    }
  )

  it('leaves a profile whose revision counter disagrees with its rows on whole-file recovery', async () => {
    const profile = await profileWithNewerSaves()
    withDatabase(profile.databaseFile, (db) =>
      db.prepare("UPDATE profile_state_meta SET value = '1' WHERE key = 'revision'").run()
    )
    expect(startupFailure(profile).repairableSections).toBeUndefined()
    expect(() => rollback(profile, { kind: 'repair' })).toThrow(
      "Orca can't repair this profile one section at a time"
    )
  })
})
