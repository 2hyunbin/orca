import { afterEach, expect, it, vi } from 'vitest'
import { getPsProcessIdentity } from './daemon-process-identity-query'

const { runProcessSync } = vi.hoisted(() => ({ runProcessSync: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcessSync, runProcess: vi.fn() }))

function psResult(stdout: string, code = 0) {
  return { code, signal: null, stdout, stderr: '', timedOut: false }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

it.each(['America/Los_Angeles', 'America/New_York', 'UTC'])(
  'keeps the autumn clock transition unambiguous under %s',
  (timezone) => {
    vi.stubEnv('TZ', timezone)
    runProcessSync.mockReturnValue(psResult('Sun Nov  1 09:30:00 2026 /path/to/orca\n'))
    expect(getPsProcessIdentity(42, { utc: true })).toEqual({
      startedAtMs: Date.parse('2026-11-01T09:30:00Z'),
      commandLine: '/path/to/orca'
    })
    expect(runProcessSync).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'ps',
        args: ['-p', '42', '-o', 'lstart=', '-o', 'command='],
        env: expect.objectContaining({ TZ: 'UTC', LC_ALL: 'C' })
      })
    )
  }
)

it('treats an unreadable UTC process start as unknown', () => {
  runProcessSync.mockReturnValue(psResult('                        /path/to/orca\n'))
  expect(getPsProcessIdentity(42, { utc: true })?.startedAtMs).toBeNull()
})

it('treats a missing pid or a timed-out ps as no identity', () => {
  runProcessSync.mockReturnValueOnce(psResult('', 1))
  expect(getPsProcessIdentity(42)).toBeNull()
  runProcessSync.mockReturnValueOnce({ ...psResult(''), code: null, timedOut: true })
  expect(getPsProcessIdentity(42)).toBeNull()
  runProcessSync.mockImplementationOnce(() => {
    throw new Error('spawn ps ENOENT')
  })
  expect(getPsProcessIdentity(42)).toBeNull()
})
