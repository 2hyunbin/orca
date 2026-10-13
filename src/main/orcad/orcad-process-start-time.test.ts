import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as DaemonProcessStartTime from '../daemon/daemon-process-start-time'

const { readWindowsProcessCreationTime, getProcessStartedAtMs } = vi.hoisted(() => ({
  readWindowsProcessCreationTime: vi.fn<(pid: number) => number | null>(),
  getProcessStartedAtMs: vi.fn<(pid: number) => number | null>()
}))
vi.mock('../windows/windows-process-table', () => ({ readWindowsProcessCreationTime }))
vi.mock('../daemon/daemon-process-start-time', async (importOriginal) => ({
  ...(await importOriginal<typeof DaemonProcessStartTime>()),
  getProcessStartedAtMs
}))

import {
  compareOrcadProcessIdentity,
  readOrcadProcessStartedAtMs
} from './orcad-process-start-time'

const platform = process.platform
function onPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

afterEach(() => {
  onPlatform(platform)
  vi.resetAllMocks()
})

describe('orcad process start time', () => {
  it('reads the addon creation time on Windows, never the POSIX probe', () => {
    onPlatform('win32')
    readWindowsProcessCreationTime.mockReturnValue(1_700_000_000_123)
    expect(readOrcadProcessStartedAtMs(42)).toBe(1_700_000_000_123)
    expect(readWindowsProcessCreationTime).toHaveBeenCalledWith(42)
    expect(getProcessStartedAtMs).not.toHaveBeenCalled()
  })

  it('keeps the POSIX probe elsewhere', () => {
    onPlatform('linux')
    getProcessStartedAtMs.mockReturnValue(5_000)
    expect(readOrcadProcessStartedAtMs(42)).toBe(5_000)
    expect(readWindowsProcessCreationTime).not.toHaveBeenCalled()
  })

  it('tells a reused Windows PID apart, and fails open when the addon cannot answer', () => {
    onPlatform('win32')
    readWindowsProcessCreationTime.mockReturnValue(9_000_000)
    expect(compareOrcadProcessIdentity(42, { startedAtMs: 1_000 })).toBe('differs')
    expect(compareOrcadProcessIdentity(42, { startedAtMs: 9_000_100 })).toBe('matches')
    readWindowsProcessCreationTime.mockReturnValue(null)
    expect(compareOrcadProcessIdentity(42, { startedAtMs: 1_000 })).toBe('unknown')
  })
})

describe('orcad process identity', () => {
  const incarnation = { linuxStartTicks: '1234', bootId: 'boot-a' }
  const recorded = { startedAtMs: 1_000, ...incarnation }

  it('matches on ticks and boot id even when the btime-derived start time drifted', () => {
    expect(
      compareOrcadProcessIdentity(42, recorded, {
        startedAtMs: () => 158_000,
        incarnation: () => incarnation,
        platform: 'linux'
      })
    ).toBe('matches')
  })

  it.each([
    ['different start ticks', { ...incarnation, linuxStartTicks: '9999' }],
    ['a different boot', { ...incarnation, bootId: 'boot-b' }]
  ])('proves reuse on %s', (_name, actual) => {
    expect(compareOrcadProcessIdentity(42, recorded, { incarnation: () => actual })).toBe('differs')
  })

  it('is unknown, never different, when the incarnation cannot be read', () => {
    expect(compareOrcadProcessIdentity(42, recorded, { incarnation: () => null })).toBe('unknown')
  })

  it('reads a Linux wall-clock mismatch on a record without ticks as unproven', () => {
    expect(
      compareOrcadProcessIdentity(
        42,
        { startedAtMs: 1_000 },
        { startedAtMs: () => 158_000, incarnation: () => incarnation, platform: 'linux' }
      )
    ).toBe('unproven')
  })
})
