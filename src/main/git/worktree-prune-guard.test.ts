import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn(async () => ({ stdout: '', stderr: '' })))
vi.mock('./runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))
const wslDistroForCommandMock = vi.hoisted(() => vi.fn((): string | null => null))
vi.mock('./command-runner/git-command-resolution', () => ({
  wslDistroForCommand: wslDistroForCommandMock
}))
vi.mock('./wsl-linked-worktree-git-routing', () => ({
  usesHostGitForWslLinkedWorktree: () => false
}))

import { ForeignWorktreeLinksError, pruneGitWorktrees } from './worktree-prune-guard'

let repo: string

function link(name: string, gitdir: string): void {
  mkdirSync(join(repo, '.git', 'worktrees', name), { recursive: true })
  writeFileSync(join(repo, '.git', 'worktrees', name, 'gitdir'), `${gitdir}\n`)
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'orca-prune-guard-'))
  mkdirSync(join(repo, '.git'))
  gitExecFileAsyncMock.mockClear()
  wslDistroForCommandMock.mockReturnValue(null)
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

describe('pruneGitWorktrees', () => {
  it('keeps WSL-made worktrees from a prune run by Windows Git', async () => {
    link('native', 'C:/src/app-feature/.git')
    link('wsl', '/mnt/c/src/app-wsl/.git')
    link('distro', '/home/me/orca/workspaces/app/fix/.git')
    await expect(pruneGitWorktrees({ cwd: repo }, 'win32')).rejects.toEqual(
      new ForeignWorktreeLinksError(['/mnt/c/src/app-wsl', '/home/me/orca/workspaces/app/fix'])
    )
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('keeps Windows-made worktrees from a prune run by WSL Git', async () => {
    wslDistroForCommandMock.mockReturnValue('Ubuntu')
    link('wsl', '/mnt/c/src/app-wsl/.git')
    link('windows', String.raw`C:\src\app-feature\.git`)
    await expect(
      pruneGitWorktrees({ cwd: repo, wslDistro: 'Ubuntu' }, 'win32')
    ).rejects.toBeInstanceOf(ForeignWorktreeLinksError)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('prunes when every link is native to the Git that runs', async () => {
    link('native', 'C:/src/app-feature/.git')
    await pruneGitWorktrees({ cwd: repo }, 'win32')
    expect(gitExecFileAsyncMock).toHaveBeenCalledExactlyOnceWith(['worktree', 'prune'], {
      cwd: repo
    })
  })

  it('prunes without reading links off Windows', async () => {
    link('linux', '/home/me/app-feature/.git')
    await pruneGitWorktrees({ cwd: repo }, 'linux')
    expect(gitExecFileAsyncMock).toHaveBeenCalledOnce()
  })
})
