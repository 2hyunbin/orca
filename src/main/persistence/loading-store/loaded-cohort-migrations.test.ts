import { afterEach, describe, expect, it, vi } from 'vitest'
import * as crypto from 'node:crypto'
import { getDefaultPersistedState } from '../../../shared/constants'
import {
  drawWorkspaceDiscoveryCohort,
  LoadedCohortMigrationOperations
} from './loaded-cohort-migrations'

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof crypto>()),
  randomInt: vi.fn()
}))

afterEach(() => vi.resetAllMocks())

describe('onboarding language experiment', () => {
  it.each([
    { draw: 0, cohort: 'control' },
    { draw: 1, cohort: 'treatment' }
  ])(
    'assigns and freezes the $cohort experience with the system language for a new install',
    ({ draw, cohort }) => {
      vi.mocked(crypto.randomInt).mockImplementation(() => draw)
      const runtime = { loadNeedsSave: false }
      const migration = new LoadedCohortMigrationOperations(runtime)
      const fresh = migration.migrateTelemetry(getDefaultPersistedState('/test'), false)
      expect(fresh.settings.telemetry?.onboardingLanguageCohort).toBe(cohort)
      expect(fresh.settings.uiLanguage).toBe('system')
      expect(runtime.loadNeedsSave).toBe(true)
      const reopened = migration.migrateTelemetry(JSON.parse(JSON.stringify(fresh)), true)
      expect(reopened).toEqual(fresh)
      expect(crypto.randomInt).toHaveBeenCalledExactlyOnceWith(2)
    }
  )

  it('excludes existing profiles and preserves their language', () => {
    const migration = new LoadedCohortMigrationOperations({ loadNeedsSave: false })
    const profile = getDefaultPersistedState('/test')
    profile.settings.uiLanguage = 'fr'
    const upgraded = migration.migrateTelemetry(profile, true)
    expect(upgraded.settings.telemetry?.onboardingLanguageCohort).toBeUndefined()
    expect(upgraded.settings.uiLanguage).toBe('fr')
    expect(crypto.randomInt).not.toHaveBeenCalled()
    expect(migration.migrateTelemetry(upgraded, true)).toEqual(upgraded)
  })
})

describe('workspace discovery experiments', () => {
  it('draws about 20% control, reproducibly from the install ID', () => {
    const ids = Array.from({ length: 10_000 }, (_, index) => `install-${index}`)
    const control = ids.filter((id) => drawWorkspaceDiscoveryCohort(id) === 'control').length
    expect(control / ids.length).toBeGreaterThan(0.18)
    expect(control / ids.length).toBeLessThan(0.22)
    expect(ids.map(drawWorkspaceDiscoveryCohort)).toEqual(ids.map(drawWorkspaceDiscoveryCohort))
  })

  it.each([
    { fileExisted: false, field: 'workspaceDiscoveryNewUserCohort' },
    { fileExisted: true, field: 'workspaceDiscoveryExistingUserCohort' }
  ] as const)('freezes the install draw into $field', ({ fileExisted, field }) => {
    const runtime = { loadNeedsSave: false }
    const migration = new LoadedCohortMigrationOperations(runtime)
    const assigned = migration.assignWorkspaceDiscoveryCohort(
      migration.migrateTelemetry(getDefaultPersistedState('/test'), fileExisted),
      fileExisted
    )
    const telemetry = assigned.settings.telemetry
    if (!telemetry) {
      throw new Error('Migrated profile has no telemetry settings')
    }
    expect(telemetry[field]).toBe(drawWorkspaceDiscoveryCohort(telemetry.installId))
    expect(
      fileExisted
        ? telemetry.workspaceDiscoveryNewUserCohort
        : telemetry.workspaceDiscoveryExistingUserCohort
    ).toBeUndefined()
    expect(runtime.loadNeedsSave).toBe(true)
    const reopened = JSON.parse(JSON.stringify(assigned))
    expect(migration.assignWorkspaceDiscoveryCohort(reopened, true)).toEqual(assigned)
  })
})
