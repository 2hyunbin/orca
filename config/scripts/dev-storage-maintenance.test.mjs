import { expect, it, vi } from 'vitest'
import { startDevStorageMaintenance } from './dev-storage-maintenance.mjs'

it.each([
  { platform: 'linux', env: {} },
  { platform: 'win32', env: {} },
  { platform: 'darwin', env: { ORCA_DISABLE_STORAGE_MAINTENANCE: '1' } },
  { platform: 'darwin', env: { CI: '1' } },
  { platform: 'darwin', env: { VITEST: 'true' } },
  { platform: 'darwin', env: { ORCA_ELECTRON_VITE_CLI: 'fake-cli.mjs' } }
])('does not launch maintenance when disabled: %j', ({ platform, env }) => {
  const spawn = vi.fn()
  startDevStorageMaintenance('/repo', { platform, env, spawn })
  expect(spawn).not.toHaveBeenCalled()
})

it('detaches the automatic sweep and leaves startup independent of failures', () => {
  const child = { on: vi.fn(), unref: vi.fn() }
  const spawn = vi.fn(() => child)
  startDevStorageMaintenance('/repo', { platform: 'darwin', env: {}, spawn })
  expect(spawn.mock.calls[0][0]).toMatchObject({ detached: true, stdio: 'ignore' })
  expect(spawn.mock.calls[0][0].args.slice(1)).toEqual([
    '--repo',
    '/repo',
    '--apply',
    '--automatic'
  ])
  expect(child.on).toHaveBeenCalledWith('error', expect.any(Function))
  expect(child.unref).toHaveBeenCalledOnce()
  expect(() =>
    startDevStorageMaintenance('/repo', {
      platform: 'darwin',
      env: {},
      spawn: () => {
        throw new Error('unavailable')
      }
    })
  ).not.toThrow()
})
