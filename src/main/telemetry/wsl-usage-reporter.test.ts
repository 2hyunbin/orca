import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const trackMock = vi.hoisted(() => vi.fn(() => true))
vi.mock('./client', () => ({
  track: trackMock,
  isTelemetryEnabled: () => true
}))

import type { Store } from '../persistence'
import { WSL_USAGE_SNAPSHOT_INTERVAL_MS, WslUsageReporter } from './wsl-usage-reporter'
import type { WslUsageSnapshotInput } from './wsl-usage-snapshot'

const input: WslUsageSnapshotInput = {
  registeredDistroCount: 1,
  userDistros: [{ version: 2, state: 'running' }],
  wslPackageVersion: '2.4.13',
  wslAvailableCached: true,
  projects: [],
  wslHostsGateOpen: false
}

// SAFETY: the reporter only hands the store to `gather`, which these tests replace.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see above.
const store = {} as Store

describe('WslUsageReporter', () => {
  let dir: string
  let now: number
  const gather = vi.fn(async () => input)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wsl-usage-'))
    now = 1_000_000_000_000
    trackMock.mockClear()
    trackMock.mockReturnValue(true)
    gather.mockClear()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function reporter(overrides: Partial<ConstructorParameters<typeof WslUsageReporter>[2]> = {}) {
    return new WslUsageReporter(store, dir, {
      platform: 'win32',
      now: () => now,
      telemetryEnabled: () => true,
      gather,
      ...overrides
    })
  }

  it('sends once, then not again within a day, across restarts', async () => {
    expect(await reporter().reportIfDue()).toBe(true)
    expect(trackMock).toHaveBeenCalledWith('wsl_usage_snapshot', expect.any(Object))
    const stamp: unknown = JSON.parse(readFileSync(join(dir, 'wsl-usage-telemetry.json'), 'utf8'))
    expect(stamp).toEqual({ lastSentAt: now })

    now += WSL_USAGE_SNAPSHOT_INTERVAL_MS - 1
    expect(await reporter().reportIfDue()).toBe(false)
    expect(gather).toHaveBeenCalledTimes(1)

    now += 1
    expect(await reporter().reportIfDue()).toBe(true)
    expect(gather).toHaveBeenCalledTimes(2)
  })

  it('gathers nothing off Windows or while telemetry is off', async () => {
    expect(await reporter({ platform: 'darwin' }).reportIfDue()).toBe(false)
    expect(await reporter({ platform: 'linux' }).reportIfDue()).toBe(false)
    expect(await reporter({ telemetryEnabled: () => false }).reportIfDue()).toBe(false)
    expect(gather).not.toHaveBeenCalled()
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('stamps a dropped send so the gather is not repaid hourly', async () => {
    trackMock.mockReturnValue(false)
    const instance = reporter()
    expect(await instance.reportIfDue()).toBe(false)
    now += 60 * 60 * 1000
    expect(await instance.reportIfDue()).toBe(false)
    expect(gather).toHaveBeenCalledTimes(1)
  })

  it('treats a corrupt stamp as never sent', async () => {
    writeFileSync(join(dir, 'wsl-usage-telemetry.json'), 'not json')
    expect(await reporter().reportIfDue()).toBe(true)
  })

  it('never throws when gathering fails', async () => {
    gather.mockRejectedValueOnce(new Error('reg.exe timed out'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await reporter().reportIfDue()).toBe(false)
    warn.mockRestore()
  })
})
