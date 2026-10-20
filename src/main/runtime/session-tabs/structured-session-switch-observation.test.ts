import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { switchStartProcessVerdict } from './structured-session-switch-observation'

const table = vi.hoisted(() => {
  const state: {
    created: number | null
    rows: { pid: number; ppid: number; name: string; creationTimeMs?: number }[]
  } = { created: null, rows: [] }
  return state
})
vi.mock('../../windows/windows-process-table', () => ({
  isWindowsProcessStartTimeAvailable: () => true,
  readWindowsProcessCreationTime: () => table.created,
  readWindowsProcessIdentityTableFresh: async () => table.rows,
  readWindowsProcessTableFresh: async () => []
}))

const AGENT = { pid: 4242, platform: 'win32', startTime: '1000' } as const
const platform = process.platform
beforeEach(() => Object.defineProperty(process, 'platform', { value: 'win32' }))
afterEach(() => Object.defineProperty(process, 'platform', { value: platform }))

it('reads an unreadable Windows identity as unverifiable, and only absence or reuse as exited', async () => {
  table.created = null
  table.rows = [{ pid: 4242, ppid: 1, name: 'codex.exe' }]
  expect(await switchStartProcessVerdict(AGENT)).toBe('unverifiable')
  table.rows = []
  expect(await switchStartProcessVerdict(AGENT)).toBe('unverifiable')
  table.rows = [{ pid: 7, ppid: 1, name: 'other.exe' }]
  expect(await switchStartProcessVerdict(AGENT)).toBe('exited')
  table.rows = [{ pid: 4242, ppid: 1, name: 'codex.exe', creationTimeMs: 2000 }]
  expect(await switchStartProcessVerdict(AGENT)).toBe('exited')
  table.created = 1000
  expect(await switchStartProcessVerdict(AGENT)).toBe('live')
})
