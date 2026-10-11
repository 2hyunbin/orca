import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { withFileTransactionLock } from '../file-transaction-lock'

const clones = vi.hoisted(() => ({ probe: vi.fn(), copy: vi.fn() }))
vi.mock('../ipc/worktree-apfs-clone', () => ({
  canCloneWithApfs: clones.probe,
  cloneWorktreePathWithApfs: clones.copy
}))
import { tryMaterializeSharedWorktreeSource } from './worktree-source-cache'
import { WorktreePreparationLockOwnershipError } from './worktree-preparation-lock'

const roots: string[] = []
const runtime = { platform: 'darwin' as const, env: { ORCA_EXPERIMENTAL_SOURCE_SHARING: '1' } }
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd, terminationBarrier: true })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-shared-source-'))
  roots.push(root)
  const repo = join(root, 'repo')
  await mkdir(repo)
  await git(repo, ['init', '-q'])
  await git(repo, ['config', 'user.name', 'Test'])
  await git(repo, ['config', 'user.email', 'test@example.invalid'])
  await git(repo, ['config', 'commit.gpgsign', 'false'])
  await git(repo, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(repo, 'version.txt'), 'committed\n')
  await writeFile(join(repo, '.gitignore'), 'secret.txt\n')
  await git(repo, ['add', '.'])
  await git(repo, ['commit', '-qm', 'seed'])
  const cache = join(repo, '.git', 'orca-cache', 'tracked-source-v1')
  async function prepare(name: string, options = {}, verify = async () => {}) {
    const path = join(root, name)
    await git(repo, ['worktree', 'add', '--detach', '--no-checkout', path, 'HEAD'])
    const shared = await tryMaterializeSharedWorktreeSource(path, 'HEAD', options, verify, runtime)
    await git(path, ['reset', '--hard', 'HEAD'])
    return { path, shared }
  }
  return { root, repo, cache, prepare }
}

beforeEach(() => {
  clones.probe.mockReset().mockResolvedValue(true)
  clones.copy.mockReset().mockImplementation(async (source: string, target: string) => {
    await cp(source, target, { recursive: true, dereference: false })
  })
})
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

it('uses committed source, independent files and indexes, and one reusable seed', async () => {
  const { repo, cache, prepare } = await fixture()
  await writeFile(join(repo, 'version.txt'), 'dirty local source\n')
  await writeFile(join(repo, 'secret.txt'), 'private\n')
  const first = await prepare('first')
  expect(first.shared).toBe(true)
  const manifest = await readFile(join(cache, 'seed', 'manifest.json'), 'utf8')
  await writeFile(join(first.path, 'version.txt'), 'first edit\n')
  const second = await prepare('second')
  expect(second.shared).toBe(true)
  expect(await git(second.path, ['status', '--porcelain'])).toBe('')
  expect(await readFile(join(second.path, 'version.txt'), 'utf8')).toBe('committed\n')
  expect(await readFile(join(cache, 'seed', 'manifest.json'), 'utf8')).toBe(manifest)
  await expect(readFile(join(second.path, 'secret.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(repo, 'version.txt'), 'utf8')).toBe('dirty local source\n')
  expect(await git(first.path, ['rev-parse', '--git-path', 'index'])).not.toBe(
    await git(second.path, ['rev-parse', '--git-path', 'index'])
  )
  expect((await stat(join(first.path, 'version.txt'))).ino).not.toBe(
    (await stat(join(second.path, 'version.txt'))).ino
  )
  await git(repo, ['worktree', 'remove', '--force', first.path])
  expect(await readFile(join(second.path, 'version.txt'), 'utf8')).toBe('committed\n')
})

it('replaces the bounded seed when configuration, external attributes, or commit changes', async () => {
  const { repo, cache, prepare } = await fixture()
  await prepare('initial')
  const initial = await readFile(join(cache, 'seed', 'manifest.json'), 'utf8')
  await git(repo, ['config', 'core.autocrlf', 'true'])
  const crlf = await prepare('crlf')
  expect(await readFile(join(crlf.path, 'version.txt'), 'utf8')).toBe('committed\r\n')
  expect(await readFile(join(cache, 'seed', 'manifest.json'), 'utf8')).not.toBe(initial)
  await writeFile(join(repo, '.git', 'info', 'attributes'), '*.txt text eol=lf\n')
  const lf = await prepare('lf')
  expect(await readFile(join(lf.path, 'version.txt'), 'utf8')).toBe('committed\n')
  await writeFile(join(repo, 'version.txt'), 'new commit\n')
  await git(repo, ['commit', '-qam', 'new commit'])
  const newer = await prepare('newer')
  expect(await readFile(join(newer.path, 'version.txt'), 'utf8')).toBe('new commit\n')
  expect(await readdir(cache)).toEqual(['seed'])
})

it.each(['filter.sample.clean', 'core.sparsecheckout'])(
  'uses ordinary checkout for %s',
  async (key) => {
    const { repo, prepare } = await fixture()
    await git(repo, ['config', key, key.startsWith('filter') ? 'unused-command' : 'false'])
    if (key.startsWith('filter')) {
      await writeFile(join(repo, '.git', 'info', 'attributes'), '*.txt filter=sample\n')
    }
    expect((await prepare('ordinary')).shared).toBe(false)
    expect(clones.copy).not.toHaveBeenCalled()
  }
)

it('falls back after partial copy failure and removes cache/build staging', async () => {
  const { cache, prepare } = await fixture()
  clones.copy.mockImplementationOnce(async (source: string, target: string) => {
    await cp(source, target, { recursive: true })
    throw new Error('disk failure')
  })
  const checkout = await prepare('failure')
  expect(checkout.shared).toBe(false)
  expect(await git(checkout.path, ['status', '--porcelain'])).toBe('')
  expect(await readdir(cache)).toEqual([])
})

it('falls back while another process leases the seed, without evicting it', async () => {
  const { cache, prepare } = await fixture()
  await prepare('initial')
  const manifest = await readFile(join(cache, 'seed', 'manifest.json'), 'utf8')
  await withFileTransactionLock(join(cache, 'maintenance'), async () => {
    expect((await prepare('competing')).shared).toBe(false)
    expect(await readFile(join(cache, 'seed', 'manifest.json'), 'utf8')).toBe(manifest)
  })
})

it.each(['changed tracked file', 'unexpected file'])(
  'rejects a damaged seed: %s',
  async (damage) => {
    const { cache, prepare } = await fixture()
    await prepare('initial')
    const source = join(cache, 'seed', 'source')
    if (damage === 'changed tracked file') {
      await chmod(join(source, 'version.txt'), 0o644)
      await writeFile(join(source, 'version.txt'), 'damaged cache\n')
    } else {
      await writeFile(join(source, 'extra-secret.txt'), 'untracked\n')
    }
    const checkout = await prepare('recovered')
    expect(checkout.shared).toBe(false)
    expect(await readFile(join(checkout.path, 'version.txt'), 'utf8')).toBe('committed\n')
    expect(await git(checkout.path, ['status', '--porcelain'])).toBe('')
    expect(await readdir(cache)).toEqual([])
  }
)

it('propagates cancellation and changed worktree ownership instead of continuing checkout', async () => {
  const { root, repo } = await fixture()
  const path = join(root, 'cancelled')
  await git(repo, ['worktree', 'add', '--detach', '--no-checkout', path, 'HEAD'])
  const controller = new AbortController()
  clones.copy.mockImplementationOnce(async (source: string, target: string) => {
    await cp(source, target, { recursive: true })
    controller.abort(new Error('cancelled'))
  })
  await expect(
    tryMaterializeSharedWorktreeSource(
      path,
      'HEAD',
      { signal: controller.signal },
      async () => {},
      runtime
    )
  ).rejects.toThrow('cancelled')
  expect(await readdir(path)).toEqual(['.git'])
  await expect(
    tryMaterializeSharedWorktreeSource(
      path,
      'HEAD',
      {},
      async () => {
        throw new WorktreePreparationLockOwnershipError()
      },
      runtime
    )
  ).rejects.toThrow('lock owner changed')
})

it('keeps disabled, unsupported hosts and prepopulated worktrees on ordinary checkout', async () => {
  const { root } = await fixture()
  for (const platform of ['linux', 'win32'] as const) {
    expect(
      await tryMaterializeSharedWorktreeSource(root, 'HEAD', {}, async () => {}, {
        ...runtime,
        platform
      })
    ).toBe(false)
  }
  expect(
    await tryMaterializeSharedWorktreeSource(root, 'HEAD', {}, async () => {}, {
      ...runtime,
      env: {}
    })
  ).toBe(false)
  expect(
    await tryMaterializeSharedWorktreeSource(
      root,
      'HEAD',
      { wslDistro: 'Ubuntu' },
      async () => {},
      runtime
    )
  ).toBe(false)
  expect(await tryMaterializeSharedWorktreeSource(root, 'HEAD', {}, async () => {}, runtime)).toBe(
    false
  )
  expect(clones.copy).not.toHaveBeenCalled()
})

it('preserves whitespace in a bare repository common-directory path', async () => {
  const { repo, root } = await fixture()
  const bare = join(root, 'bare repo with trailing space ')
  await git(repo, ['clone', '--bare', repo, bare])
  const path = join(root, 'bare-checkout')
  await git(bare, ['worktree', 'add', '--detach', '--no-checkout', path, 'HEAD'])
  expect(await tryMaterializeSharedWorktreeSource(path, 'HEAD', {}, async () => {}, runtime)).toBe(
    true
  )
  expect(
    await readFile(
      join(bare, 'orca-cache', 'tracked-source-v1', 'seed', 'source', 'version.txt'),
      'utf8'
    )
  ).toBe('committed\n')
})
