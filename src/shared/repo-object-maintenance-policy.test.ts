import { describe, expect, it } from 'vitest'
import {
  isGitMaintenanceCommandLine,
  isStaleMaintenanceLock,
  MAINTENANCE_LOCK_STALE_MS,
  supportsPromisorGeometricRepack
} from './repo-object-maintenance-policy'

const OLD = MAINTENANCE_LOCK_STALE_MS + 1

describe('stale maintenance lock decision', () => {
  it('needs age, no running git maintenance, and (for gc.pid) no live owner', () => {
    expect(isStaleMaintenanceLock({ ageMs: OLD, gitMaintenanceRunning: false })).toBe(true)
    expect(
      isStaleMaintenanceLock({ ageMs: MAINTENANCE_LOCK_STALE_MS, gitMaintenanceRunning: false })
    ).toBe(false)
    expect(isStaleMaintenanceLock({ ageMs: OLD, gitMaintenanceRunning: true })).toBe(false)
    expect(
      isStaleMaintenanceLock({ ageMs: OLD, gitMaintenanceRunning: false, gcPidLive: true })
    ).toBe(false)
    expect(
      isStaleMaintenanceLock({ ageMs: OLD, gitMaintenanceRunning: false, gcPidLive: false })
    ).toBe(true)
  })

  it('recognizes gc, maintenance and repack processes on every platform', () => {
    for (const line of [
      'git maintenance run --task=geometric-repack',
      '/usr/bin/git -c maintenance.autoDetach=false maintenance run --quiet',
      '/opt/homebrew/bin/git gc --auto',
      'git repack -d -l --geometric=2',
      'git pack-objects --local --delta-base-offset .git/objects/pack/.tmp-1-pack',
      '/usr/lib/git-core/git-pack-objects --revs',
      '"C:\\Program Files\\Git\\mingw64\\bin\\git.exe" maintenance run --task=gc',
      '/Applications/Some App.app/Contents/Resources/git gc'
    ]) {
      expect(isGitMaintenanceCommandLine(line), line).toBe(true)
    }
    for (const line of [
      'git fetch origin',
      '/usr/bin/git status --porcelain',
      'node --expose-gc server.js',
      'vim maintenance.md'
    ]) {
      expect(isGitMaintenanceCommandLine(line), line).toBe(false)
    }
  })
})

describe('promisor-aware geometric repack support', () => {
  it('starts at Git 2.53, including vendor builds', () => {
    expect(supportsPromisorGeometricRepack('git version 2.53.0\n')).toBe(true)
    expect(supportsPromisorGeometricRepack('git version 2.55.0.windows.1')).toBe(true)
    expect(supportsPromisorGeometricRepack('git version 2.52.9')).toBe(false)
    expect(supportsPromisorGeometricRepack('git version 2.39.5 (Apple Git-154)')).toBe(false)
    expect(supportsPromisorGeometricRepack('')).toBe(false)
  })
})
