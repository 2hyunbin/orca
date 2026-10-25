import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  parseRepoMaintenanceConfig,
  readRepoMaintenanceConfig
} from '../../shared/repo-maintenance-config'
import {
  isGitVersionAtLeast,
  OBJECT_PACK_COUNT_THRESHOLD,
  parseGitVersion
} from '../../shared/repo-object-maintenance-policy'
import { maintainRepoObjects } from './repo-object-maintenance'

const BLOBS = OBJECT_PACK_COUNT_THRESHOLD + 10
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

const version = parseGitVersion(execFileSync('git', ['--version'], { encoding: 'utf8' }))
const supported = version !== undefined && isGitVersionAtLeast(version, 2, 30)

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-object-maintenance-git-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe.skipIf(!supported)('idle object maintenance against real Git', () => {
  it('compacts a fragmented blob:none clone without pruning an unreachable worktree', async () => {
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
    // `<mode> blob <oid>\tfile-<n>.txt`; --object-only needs Git 2.36.
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
    expect(before).toBeGreaterThanOrEqual(OBJECT_PACK_COUNT_THRESHOLD)

    const config = readRepoMaintenanceConfig(
      parseRepoMaintenanceConfig(
        git(clone, ['config', '--get-regexp', '^remote\\..+\\.promisor$'])
      ),
      [clone]
    )
    expect(config.partialClone).toBe(true)
    const outcome = await maintainRepoObjects({
      repoPath: clone,
      commonDir: join(clone, '.git'),
      config,
      signal: new AbortController().signal,
      span: { setAttribute: () => {} },
      canWrite: () => true,
      canRunBacklog: () => true
    })

    expect(outcome).toBe('ran')
    if (version && isGitVersionAtLeast(version, 2, 53)) {
      expect(await packCount(clone)).toBeLessThan(before)
    }
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
