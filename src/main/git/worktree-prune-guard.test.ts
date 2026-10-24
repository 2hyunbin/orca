import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const lockedDuringPrune = vi.hoisted(() => {
  const value: string[] = []
  return { value }
})
const repoRef = vi.hoisted(() => ({ value: '' }))
const gitExecFileAsyncMock = vi.hoisted(() =>
  vi.fn(async (args: string[]) => {
    if (args[0] === 'rev-parse') {
      return { stdout: '.git\n', stderr: '' }
    }
    const { readdirSync, existsSync: exists } = await import('node:fs')
    const { join: joinPath } = await import('node:path')
    const admin = joinPath(repoRef.value, '.git', 'worktrees')
    lockedDuringPrune.value = readdirSync(admin).filter((name) =>
      exists(joinPath(admin, name, 'locked'))
    )
    return { stdout: '', stderr: '' }
  })
)
vi.mock('./runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))
const wslDistroForCommandMock = vi.hoisted(() => vi.fn((): string | null => null))
vi.mock('./command-runner/git-command-resolution', () => ({
  wslDistroForCommand: wslDistroForCommandMock
}))
vi.mock('./wsl-linked-worktree-git-routing', () => ({
  usesHostGitForWslLinkedWorktree: () => false
}))
vi.mock('./wsl-drive-checkout-git-routing', () => ({
  pendingWslDriveCheckoutGitRouting: () => null
}))

import { isForeignLink, pruneGitWorktrees } from './worktree-prune-guard'

let repo: string

function link(name: string, gitdir: string): void {
  mkdirSync(join(repo, '.git', 'worktrees', name), { recursive: true })
  writeFileSync(join(repo, '.git', 'worktrees', name, 'gitdir'), `${gitdir}\n`)
}

const lockFile = (name: string) => join(repo, '.git', 'worktrees', name, 'locked')

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'orca-prune-guard-'))
  repoRef.value = repo
  mkdirSync(join(repo, '.git', 'worktrees'), { recursive: true })
  gitExecFileAsyncMock.mockClear()
  lockedDuringPrune.value = []
  wslDistroForCommandMock.mockReturnValue(null)
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

describe('pruneGitWorktrees', () => {
  it('locks WSL-made worktrees while Windows Git prunes, then unlocks them', async () => {
    link('native', 'C:/src/app-feature/.git')
    link('wsl', '/mnt/c/src/app-wsl/.git')
    link('distro', '/home/me/orca/workspaces/app/fix/.git')
    await pruneGitWorktrees({ cwd: repo }, 'win32')
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'prune'], { cwd: repo })
    expect(lockedDuringPrune.value.sort()).toEqual(['distro', 'wsl'])
    expect(existsSync(lockFile('wsl'))).toBe(false)
    expect(existsSync(lockFile('distro'))).toBe(false)
  })

  it('locks Windows-made worktrees while WSL Git prunes', async () => {
    wslDistroForCommandMock.mockReturnValue('Ubuntu')
    link('wsl', '/mnt/c/src/app-wsl/.git')
    link('windows', String.raw`C:\src\app-feature\.git`)
    link('share', '//server/share/app-feature/.git')
    await pruneGitWorktrees({ cwd: repo, wslDistro: 'Ubuntu' }, 'win32')
    expect(lockedDuringPrune.value.sort()).toEqual(['share', 'windows'])
  })

  it("keeps the user's own lock in place", async () => {
    link('wsl', '/mnt/c/src/app-wsl/.git')
    writeFileSync(lockFile('wsl'), 'mine')
    await pruneGitWorktrees({ cwd: repo }, 'win32')
    expect(readFileSync(lockFile('wsl'), 'utf8')).toBe('mine')
  })

  it('unlocks even when the prune fails', async () => {
    link('wsl', '/mnt/c/src/app-wsl/.git')
    gitExecFileAsyncMock.mockImplementationOnce(async () => ({ stdout: '.git\n', stderr: '' }))
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('prune failed'))
    await expect(pruneGitWorktrees({ cwd: repo }, 'win32')).rejects.toThrow('prune failed')
    expect(existsSync(lockFile('wsl'))).toBe(false)
  })

  it('reads no links off Windows', async () => {
    link('linux', '/home/me/app-feature/.git')
    await pruneGitWorktrees({ cwd: repo }, 'linux')
    expect(gitExecFileAsyncMock).toHaveBeenCalledExactlyOnceWith(['worktree', 'prune'], {
      cwd: repo
    })
  })
})

describe('isForeignLink', () => {
  it.each([
    ['/mnt/c/x/.git', false, true],
    ['//server/share/x/.git', false, false],
    ['C:/x/.git', false, false],
    ['../x/.git', false, false],
    ['C:/x/.git', true, true],
    [String.raw`\\?\C:\x\.git`, true, true],
    ['/home/me/x/.git', true, false],
    ['../x/.git', true, false]
  ])('%s with WSL Git=%s is foreign: %s', (link, runsInWsl, foreign) => {
    expect(isForeignLink(link, runsInWsl)).toBe(foreign)
  })
})
