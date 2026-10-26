import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  OBJECT_PACK_COUNT_THRESHOLD,
  supportsPromisorGeometricRepack
} from '../../shared/repo-object-maintenance-policy'
import { maintainRepoObjects, probeRepoObjectStore } from './repo-object-maintenance'

const BLOBS = OBJECT_PACK_COUNT_THRESHOLD + 10
let root = ''

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], {
    cwd,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

async function writeLooseBlob(repoPath: string, content: string): Promise<string> {
  const object = Buffer.from(`blob ${Buffer.byteLength(content)}\0${content}`)
  const oid = createHash('sha1').update(object).digest('hex')
  const directory = join(repoPath, '.git', 'objects', oid.slice(0, 2))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, oid.slice(2)), deflateSync(object))
  return oid
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
  it.each([true, false])(
    'retains old unreachable objects during a full-repack fallback with cruft packs %s',
    async (cruftPacks) => {
      const repo = join(root, `unreachable-${cruftPacks}`)
      git(root, ['init', '--quiet', '--object-format=sha1', repo])
      git(repo, ['config', 'user.email', 'test@example.com'])
      git(repo, ['config', 'user.name', 'Test User'])
      git(repo, ['config', 'gc.pruneExpire', 'now'])
      git(repo, ['config', 'gc.cruftPacks', String(cruftPacks)])
      await writeFile(join(repo, 'reachable.txt'), 'reachable content')
      git(repo, ['add', '.'])
      git(repo, ['commit', '--quiet', '-m', 'initial'])
      const reachable = git(repo, ['rev-list', '--objects', '--all'])
        .split('\n')
        .map((line) => line.split(' ')[0])
      const unreachable = await Promise.all(
        reachable.map((_, index) => writeLooseBlob(repo, `unreachable packed blob ${index}`))
      )
      // Equal object counts force geometric maintenance's full-repack fallback.
      for (const objects of [reachable, unreachable]) {
        git(repo, ['pack-objects', '.git/objects/pack/pack'], `${objects.join('\n')}\n`)
      }
      git(repo, ['prune-packed'])
      const packs = join(repo, '.git', 'objects', 'pack')
      const old = new Date(Date.UTC(2020, 0, 1))
      for (const name of await readdir(packs)) {
        await utimes(join(packs, name), old, old)
      }
      let sampled = 0
      for (let index = 0; sampled < 27; index += 1) {
        const content = `sampled loose blob ${index}`
        const oid = createHash('sha1')
          .update(`blob ${Buffer.byteLength(content)}\0${content}`)
          .digest('hex')
        if (oid.startsWith('17')) {
          await writeLooseBlob(repo, content)
          sampled += 1
        }
      }
      expect(await packCount(repo)).toBe(2)
      const outcome = await maintainRepoObjects({
        repoPath: repo,
        commonDir: join(repo, '.git'),
        signal: new AbortController().signal,
        span: { setAttribute: () => {} },
        canWrite: () => true
      })
      expect(outcome).toBe('ran')
      expect(
        git(repo, ['cat-file', '--batch-check'], `${unreachable.join('\n')}\n`)
          .split('\n')
          .map((line) => line.split(' ')[1])
      ).toEqual(unreachable.map(() => 'blob'))
      for (const oid of unreachable) {
        await expect(
          stat(join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2)))
        ).rejects.toMatchObject({ code: 'ENOENT' })
      }
      expect(git(repo, ['config', '--get', 'gc.pruneExpire'])).toBe('now')
      expect(git(repo, ['config', '--get', 'gc.cruftPacks'])).toBe(String(cruftPacks))
    },
    120_000
  )

  // Builds a source repo, a partial clone and 60 lazy fetches, each its own git process.
  it('compacts promisor packs without pruning a worktree', async () => {
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
    const args = {
      repoPath: clone,
      commonDir: join(clone, '.git'),
      signal: new AbortController().signal,
      span: { setAttribute: () => {} },
      canWrite: () => true
    }
    const lock = join(clone, '.git', 'objects', 'maintenance.lock')
    await writeFile(lock, 'external lock')
    const old = new Date(Date.UTC(2020, 0, 1))
    await utimes(lock, old, old)
    expect(await maintainRepoObjects(args)).toBe('busy')
    expect(await packCount(clone)).toBe(before)
    expect(await readFile(lock, 'utf8')).toBe('external lock')
    await rm(lock)

    const outcome = await maintainRepoObjects(args)

    expect(outcome).toBe('ran')
    expect(await packCount(clone)).toBeLessThanOrEqual(2)
    await expect(
      stat(join(clone, '.git', 'worktrees', 'unmounted-volume-worktree', 'gitdir'))
    ).resolves.toBeDefined()
    // Every lazily fetched blob is still local: no remote is reachable from here on.
    await rm(source, { recursive: true, force: true })
    expect(
      git(clone, ['cat-file', '--batch'], `${blobs.map((blob) => blob.oid).join('\n')}\n`)
    ).toBe(
      blobs
        .map(
          (blob) =>
            `${blob.oid} blob ${Buffer.byteLength(`${blob.content}\n`)}\n${blob.content}\n\n`
        )
        .join('')
        .trim()
    )
  }, 120_000)
})
