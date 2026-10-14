import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { startDevStorageReclaim } from './dev-storage-reclaim.mjs'

function fixture() {
  const child = new EventEmitter()
  child.unref = vi.fn()
  const spawn = vi.fn(() => child)
  return { child, spawn, report: vi.fn(), repoRoot: '/dev-worktree', env: {} }
}

it('starts one non-interactive worker without waiting for its exit', () => {
  const options = fixture()
  startDevStorageReclaim(options)
  expect(options.spawn).toHaveBeenCalledTimes(1)
  expect(options.spawn.mock.calls[0][0]).toMatchObject({
    args: expect.arrayContaining([
      '--automatic',
      '--apply',
      '--exclude-worktree',
      options.repoRoot
    ]),
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit']
  })
  expect(options.child.unref).toHaveBeenCalledTimes(1)
  expect(options.report).not.toHaveBeenCalled()
})

it('allows tests and developers to skip the repository-wide sweep', () => {
  const options = fixture()
  startDevStorageReclaim({ ...options, env: { ORCA_SKIP_DEV_STORAGE_RECLAIM: '1' } })
  expect(options.spawn).not.toHaveBeenCalled()
})

it('reports cleanup failure without throwing into dev startup', () => {
  const options = fixture()
  startDevStorageReclaim(options)
  options.child.emit('exit', 1)
  expect(options.report).toHaveBeenCalledWith(expect.stringContaining('pnpm reclaim'))
})

it.each([true, false])('handles both sync and async spawn errors (sync: %j)', (synchronous) => {
  const options = fixture()
  if (synchronous) {
    options.spawn.mockImplementation(() => {
      throw new Error('spawn failed')
    })
  }
  expect(() => startDevStorageReclaim(options)).not.toThrow()
  if (!synchronous) {
    options.child.emit('error', new Error('spawn failed'))
  }
  expect(options.report).toHaveBeenCalledWith(expect.stringContaining('spawn failed'))
})
