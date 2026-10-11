import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { reclaimWorktreeSpace } from './reclaim-worktree-space.mjs'

const roots = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-storage-maintenance-'))
  roots.push(root)
  const execute = vi.fn(async () => ({ code: 0, timedOut: false }))
  return { commonDirectory: root, repoRoot: root, execute }
}

it('previews both existing cleanup operations without applying either', async () => {
  const options = await fixture()
  await reclaimWorktreeSpace(options)
  expect(options.execute).toHaveBeenCalledTimes(2)
  expect(options.execute.mock.calls.flatMap(([spec]) => spec.args)).not.toContain('--apply')
})

it('forwards apply and repository selection to both cleanup operations', async () => {
  const options = { ...(await fixture()), apply: true }
  await reclaimWorktreeSpace(options)
  expect(options.execute).toHaveBeenCalledTimes(2)
  for (const [spec] of options.execute.mock.calls) {
    expect(spec.args).toContain('--apply')
    expect(spec.args).toContain(options.repoRoot)
    expect(spec.terminationBarrier).toBe(true)
  }
})

it('rejects competing sweeps and releases the lock after a failed operation', async () => {
  const options = { ...(await fixture()), apply: true }
  let release
  const blocked = new Promise((resolve) => {
    release = resolve
  })
  let entered
  const ready = new Promise((resolve) => {
    entered = resolve
  })
  options.execute.mockImplementation(async () => {
    entered()
    await blocked
    return { code: 1, timedOut: false }
  })
  const first = reclaimWorktreeSpace(options)
  const rejected = expect(first).rejects.toThrow('failed')
  await ready
  await expect(reclaimWorktreeSpace(options)).rejects.toThrow('already running')
  release()
  await rejected
  options.execute.mockResolvedValue({ code: 0, timedOut: false })
  await reclaimWorktreeSpace(options)
  expect(options.execute).toHaveBeenCalledTimes(3)
})
