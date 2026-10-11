import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

it('preserves the cleanup failure and reports a concurrent lock release failure separately', async () => {
  const options = await fixture()
  const failure = new Error('original cleanup failure')
  options.execute.mockRejectedValue(failure)
  const release = vi.fn().mockRejectedValue(new Error('lock release failure'))
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(
      reclaimWorktreeSpace({ ...options, acquireLock: async () => release })
    ).rejects.toBe(failure)
    expect(release).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith('Failed to release cleanup lock: lock release failure')
  } finally {
    report.mockRestore()
  }
})

it('fails if cleanup succeeds but the repository lock cannot be released', async () => {
  const options = await fixture()
  const failure = new Error('lock release failure')
  const release = vi.fn().mockRejectedValue(failure)
  await expect(reclaimWorktreeSpace({ ...options, acquireLock: async () => release })).rejects.toBe(
    failure
  )
  expect(options.execute).toHaveBeenCalledTimes(2)
})

it('limits automatic cleanup to older bundles outside the launching worktree, once per day', async () => {
  const options = { ...(await fixture()), automatic: true, apply: true, now: 1_000_000_000 }
  await reclaimWorktreeSpace(options)
  expect(options.execute).toHaveBeenCalledTimes(1)
  expect(options.execute.mock.calls[0][0].args.slice(1)).toEqual([
    '--repo',
    options.repoRoot,
    '--apply',
    '--min-age-days',
    '7',
    '--exclude-worktree',
    options.repoRoot
  ])
  await reclaimWorktreeSpace({ ...options, now: options.now + 86_399_999 })
  expect(options.execute).toHaveBeenCalledTimes(1)
  await reclaimWorktreeSpace({ ...options, now: options.now + 86_400_000 })
  expect(options.execute).toHaveBeenCalledTimes(2)
  await reclaimWorktreeSpace({ ...options, automatic: false })
  expect(options.execute).toHaveBeenCalledTimes(4)
})

it('retries failed automatic cleanup without waiting a day', async () => {
  const options = { ...(await fixture()), automatic: true, apply: true }
  options.execute.mockResolvedValueOnce({ code: 1, timedOut: false })
  await expect(reclaimWorktreeSpace(options)).rejects.toThrow('failed')
  await reclaimWorktreeSpace(options)
  expect(options.execute).toHaveBeenCalledTimes(2)
})

it('retries malformed state and does not let a preview suppress the next applied sweep', async () => {
  const options = { ...(await fixture()), automatic: true, apply: false }
  await reclaimWorktreeSpace(options)
  await writeFile(
    join(options.commonDirectory, 'orca-cache', 'storage-cleanup-completed.json'),
    '{'
  )
  await reclaimWorktreeSpace({ ...options, apply: true })
  expect(options.execute).toHaveBeenCalledTimes(2)
})
