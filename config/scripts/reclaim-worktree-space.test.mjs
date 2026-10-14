import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { reclaimWorktreeSpace } from './reclaim-worktree-space.mjs'
import { runProcess } from '@orca/process-host'

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

it('previews historical test caches and both Electron cleanup operations', async () => {
  const options = await fixture()
  await reclaimWorktreeSpace(options)
  expect(options.execute).toHaveBeenCalledTimes(3)
  expect(options.execute.mock.calls.flatMap(([spec]) => spec.args)).not.toContain('--apply')
})

it('forwards apply and repository selection to all cleanup operations', async () => {
  const options = { ...(await fixture()), apply: true, testsStopped: true }
  await reclaimWorktreeSpace(options)
  expect(options.execute).toHaveBeenCalledTimes(3)
  for (const [spec] of options.execute.mock.calls) {
    expect(spec.args).toContain('--apply')
    expect(spec.args).toContain(options.repoRoot)
    expect(spec.terminationBarrier).toBe(true)
  }
  const cache = options.execute.mock.calls[0][0]
  expect(cache.args).toContain('--tests-stopped')
  expect(cache.args).toContain('--import')
  for (const [spec] of options.execute.mock.calls.slice(1)) {
    expect(spec.args).not.toContain('--tests-stopped')
  }
})

it('applies Electron cleanup and explains how to include historical caches', async () => {
  const options = { ...(await fixture()), apply: true }
  const report = vi.fn()
  await reclaimWorktreeSpace({ ...options, report })
  expect(options.execute).toHaveBeenCalledTimes(2)
  const args = options.execute.mock.calls.flatMap(([spec]) => spec.args)
  expect(args.join(' ')).not.toContain('reclaim-release-test-caches')
  for (const [spec] of options.execute.mock.calls) {
    expect(spec.args).toContain('--apply')
  }
  expect(report).toHaveBeenCalledWith(expect.stringContaining('--apply --tests-stopped'))
})

it('leaves historical caches out of automatic invocations', async () => {
  const options = { ...(await fixture()), automatic: true, apply: true }
  await reclaimWorktreeSpace(options)
  expect(options.execute.mock.calls.flatMap(([spec]) => spec.args).join(' ')).not.toContain(
    'reclaim-release-test-caches'
  )
})

it('forwards an age override only to historical test cache cleanup', async () => {
  const options = { ...(await fixture()), releaseCacheMinAgeDays: 7 }
  await reclaimWorktreeSpace(options)
  expect(options.execute.mock.calls[0][0].args).toEqual(
    expect.arrayContaining(['--min-age-days', '7'])
  )
  for (const [spec] of options.execute.mock.calls.slice(1)) {
    expect(spec.args).not.toContain('--min-age-days')
  }
})

it('rejects an invalid cache age before starting cleanup', async () => {
  const options = { ...(await fixture()), releaseCacheMinAgeDays: -1 }
  await expect(reclaimWorktreeSpace(options)).rejects.toThrow('--release-cache-min-age-days')
  expect(options.execute).not.toHaveBeenCalled()
})

it('runs from outside a repository and a linked worktree, preserving caches unless acknowledged', async () => {
  const options = await fixture()
  const init = await runProcess({
    program: 'git',
    args: ['init', '--quiet'],
    cwd: options.repoRoot,
    timeoutMs: 10_000,
    terminationBarrier: true
  })
  expect(init.code).toBe(0)
  const initialCommit = await runProcess({
    program: 'git',
    args: [
      '-c',
      'user.name=Storage Test',
      '-c',
      'user.email=storage-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'Storage fixture'
    ],
    cwd: options.repoRoot,
    timeoutMs: 10_000,
    terminationBarrier: true
  })
  expect(initialCommit.code, initialCommit.stderr).toBe(0)
  const worktree = join(options.repoRoot, 'linked-worktree')
  const add = await runProcess({
    program: 'git',
    args: ['worktree', 'add', '--quiet', '-b', 'storage-test', worktree],
    cwd: options.repoRoot,
    timeoutMs: 10_000,
    terminationBarrier: true
  })
  expect(add.code, add.stderr).toBe(0)
  const commit = 'd'.repeat(40)
  const cache = join(
    worktree,
    'tests',
    'e2e',
    '.cross-version-checkouts',
    'old',
    `${commit}-format-4`
  )
  await mkdir(cache, { recursive: true })
  const marker = join(cache, 'checkout-stamp.json')
  await writeFile(marker, JSON.stringify({ commit, format: 4 }))
  await utimes(cache, new Date(0), new Date(0))
  const run = (flags = [], cwd = worktree) =>
    runProcess({
      program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
      args: [resolve(import.meta.dirname, 'reclaim-worktree-space.mjs'), ...flags],
      cwd,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 20_000,
      terminationBarrier: true
    })
  const preview = await run(['--repo', worktree], tmpdir())
  expect(preview.code, preview.stderr).toBe(0)
  expect(preview.stdout).toContain('Would remove 1 cache(s)')
  expect(await readFile(marker, 'utf8')).toContain(commit)
  const electronOnly = await run(['--apply'])
  expect(electronOnly.code, electronOnly.stderr).toBe(0)
  expect(electronOnly.stdout).toContain('Skipping historical test caches')
  expect(electronOnly.stdout).toContain('--apply --tests-stopped')
  expect(electronOnly.stdout).toContain('Shared 0 worktree(s)')
  expect(await readFile(marker, 'utf8')).toContain(commit)
  const applied = await run(['--apply', '--tests-stopped'])
  expect(applied.code, applied.stderr).toBe(0)
  expect(applied.stdout).toContain('Removed 1 cache(s)')
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects competing sweeps and releases the lock after a failed operation', async () => {
  const options = { ...(await fixture()), apply: true, testsStopped: true }
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
  expect(options.execute).toHaveBeenCalledTimes(4)
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
  expect(options.execute).toHaveBeenCalledTimes(3)
})
