import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, expect, it, vi } from 'vitest'
import {
  prepareWorktreeCreateCheckout,
  finalizePreparedWorktree
} from './worktree-create-preparation'
import { createWorktreePreparationLockReason } from '../../shared/worktree/create-preparation'

const roots: string[] = []
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd, terminationBarrier: true })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout
}
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

it.runIf(process.platform === 'darwin')(
  'creates and finalizes real APFS worktrees with independent edits, modes and symlinks',
  async () => {
    vi.stubEnv('ORCA_EXPERIMENTAL_SOURCE_SHARING', '1')
    const root = await mkdtemp(join(tmpdir(), 'orca-source-apfs-'))
    roots.push(root)
    const repo = join(root, 'repo')
    await mkdir(repo)
    await git(repo, ['init', '-q'])
    await git(repo, ['config', 'user.name', 'Test'])
    await git(repo, ['config', 'user.email', 'test@example.invalid'])
    await git(repo, ['config', 'commit.gpgsign', 'false'])
    await git(repo, ['config', 'core.autocrlf', 'false'])
    await git(repo, ['config', 'core.filemode', 'true'])
    await writeFile(join(repo, '.gitattributes'), '*.txt text eol=crlf\n')
    await writeFile(join(repo, 'version.txt'), 'committed\n')
    await writeFile(join(repo, 'script.sh'), '#!/bin/sh\nexit 0\n')
    await chmod(join(repo, 'script.sh'), 0o755)
    await symlink('version.txt', join(repo, 'relative-link'))
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-qm', 'seed'])
    const head = (await git(repo, ['rev-parse', 'HEAD'])).trim()
    const first = join(root, 'first')
    const second = join(root, 'second')
    const firstLock = createWorktreePreparationLockReason('first')
    await prepareWorktreeCreateCheckout(repo, first, head, firstLock)
    const seed = join(repo, '.git', 'orca-cache', 'tracked-source-v1', 'seed', 'source')
    const originalSeedInode = (await stat(join(seed, 'version.txt'))).ino
    await finalizePreparedWorktree(
      repo,
      first,
      join(root, 'final'),
      'feature',
      head,
      false,
      {},
      firstLock
    )
    await prepareWorktreeCreateCheckout(
      repo,
      second,
      head,
      createWorktreePreparationLockReason('second')
    )
    const final = join(root, 'final')
    expect((await stat(join(seed, 'version.txt'))).ino).toBe(originalSeedInode)
    expect(await readFile(join(seed, 'version.txt'), 'utf8')).toBe('committed\r\n')
    expect(await readFile(join(second, 'version.txt'), 'utf8')).toBe('committed\r\n')
    expect(await git(final, ['status', '--porcelain'])).toBe('')
    expect(await git(second, ['status', '--porcelain'])).toBe('')
    expect((await stat(join(second, 'script.sh'))).mode & 0o111).toBe(0o111)
    expect(await readlink(join(second, 'relative-link'))).toBe('version.txt')
    expect((await stat(join(second, 'version.txt'))).ino).not.toBe(
      (await stat(join(seed, 'version.txt'))).ino
    )
    await writeFile(join(final, 'version.txt'), 'independent edit\n')
    expect(await readFile(join(second, 'version.txt'), 'utf8')).toBe('committed\r\n')
    expect(await readFile(join(seed, 'version.txt'), 'utf8')).toBe('committed\r\n')
  }
)
