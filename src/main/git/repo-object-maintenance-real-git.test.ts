import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as ProcessHost from '@orca/process-host'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  OBJECT_PACK_COUNT_THRESHOLD,
  supportsPromisorGeometricRepack
} from '../../shared/repo-object-maintenance-policy'
import { maintainRepoObjects, probeRepoObjectStore } from './repo-object-maintenance'

// A real gc on the developer's machine must not decide whether the stale lock is removed.
vi.mock('@orca/process-host', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessHost>()
  return {
    ...actual,
    runProcess: (options: Parameters<typeof actual.runProcess>[0]) =>
      options.program === 'ps' || options.program === 'powershell.exe'
        ? Promise.resolve({ code: 0, timedOut: false, stdout: '', stderr: '' })
        : actual.runProcess(options)
  }
})

const BLOBS = OBJECT_PACK_COUNT_THRESHOLD + 10
const LONG_AGO = new Date(Date.UTC(2020, 0, 1))
let root = ''

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

async function packCount(repoPath: string): Promise<number> {
  const names = await readdir(join(repoPath, '.git', 'objects', 'pack'))
  return names.filter((name) => name.endsWith('.pack')).length
}

const supported = supportsPromisorGeometricRepack(
  execFileSync('git', ['--version'], { encoding: 'utf8' })
)

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-object-maintenance-git-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('pack count trigger', () => {
  it('counts promisor packs toward the threshold', async () => {
    const pack = join(root, 'probe', 'objects', 'pack')
    await mkdir(pack, { recursive: true })
    for (let index = 0; index < OBJECT_PACK_COUNT_THRESHOLD - 1; index += 1) {
      await writeFile(join(pack, `pack-${index}.pack`), '')
      await writeFile(join(pack, `pack-${index}.promisor`), '')
    }
    const signal = new AbortController().signal
    expect((await probeRepoObjectStore(join(root, 'probe'), signal)).packCount).toBe(
      OBJECT_PACK_COUNT_THRESHOLD - 1
    )
    await writeFile(join(pack, 'pack-last.pack'), '')
    expect((await probeRepoObjectStore(join(root, 'probe'), signal)).packCount).toBe(
      OBJECT_PACK_COUNT_THRESHOLD
    )
  })
})

describe.skipIf(!supported)('idle object maintenance against real Git', () => {
  // Builds a source repo, a partial clone and 60 lazy fetches, each its own git process.
  it('clears a stale lock and compacts promisor packs without pruning a worktree', async () => {
    const source = join(root, 'source')
    git(root, ['init', '--quiet', source])
    git(source, ['config', 'user.email', 'test@example.com'])
    git(source, ['config', 'user.name', 'Test User'])
    git(source, ['config', 'uploadpack.allowFilter', 'true'])
    git(source, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])
    for (let index = 0; index < BLOBS; index += 1) {
      await writeFile(join(source, `file-${index}.txt`), `content ${index}\n`)
    }
    git(source, ['add', '.'])
    git(source, ['commit', '--quiet', '-m', 'initial'])
    // `<mode> blob <oid>\tfile-<n>.txt`
    const blobs = git(source, ['ls-tree', 'HEAD'])
      .split('\n')
      .map((line) => {
        const [meta, path] = line.split('\t')
        return { oid: meta.split(' ')[2], content: `content ${/\d+/.exec(path)?.[0]}` }
      })

    const clone = join(root, 'clone')
    git(root, [
      'clone',
      '--quiet',
      '--no-checkout',
      '--filter=blob:none',
      pathToFileURL(source).href,
      clone
    ])
    // Each lazy read writes its own promisor pack, as on-demand fetches do across many worktrees.
    for (const blob of blobs) {
      git(clone, ['cat-file', '-p', blob.oid])
    }
    const worktree = join(root, 'unmounted-volume-worktree')
    git(clone, ['worktree', 'add', '--quiet', '--detach', worktree, 'HEAD'])
    await rm(worktree, { recursive: true, force: true })
    // Any gc or worktree-prune task would now remove the missing worktree immediately.
    git(clone, ['config', 'gc.worktreePruneExpire', 'now'])
    const before = await packCount(clone)
    expect(before).toBeGreaterThanOrEqual(BLOBS)
    // A killed run's lock: every `git maintenance run` would exit 0 having done nothing.
    const lock = join(clone, '.git', 'objects', 'maintenance.lock')
    await writeFile(lock, '')
    await utimes(lock, LONG_AGO, LONG_AGO)

    const outcome = await maintainRepoObjects({
      repoPath: clone,
      commonDir: join(clone, '.git'),
      signal: new AbortController().signal,
      span: { setAttribute: () => {} },
      canWrite: () => true
    })

    expect(outcome).toBe('ran')
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await packCount(clone)).toBeLessThanOrEqual(2)
    await expect(
      stat(join(clone, '.git', 'worktrees', 'unmounted-volume-worktree', 'gitdir'))
    ).resolves.toBeDefined()
    // Every lazily fetched blob is still local: no remote is reachable from here on.
    await rm(source, { recursive: true, force: true })
    for (const blob of blobs) {
      expect(git(clone, ['cat-file', '-p', blob.oid])).toBe(blob.content)
    }
  }, 60_000)
})
