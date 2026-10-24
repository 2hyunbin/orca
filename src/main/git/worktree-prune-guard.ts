/**
 * `git worktree prune` deletes the metadata of every linked worktree whose link doesn't resolve.
 * On Windows one repo can hold links written by both Windows Git (`C:/…`) and WSL Git (`/mnt/c/…`,
 * `/home/…`), e.g. after its runtime was switched; each Git reads the other's links as missing and
 * would prune those worktrees. So prune only when every link is native to the Git that runs it.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitExecOptions } from './command-runner/git-exec-options'
import { gitExecFileAsync } from './runner'
import { wslDistroForCommand } from './command-runner/git-command-resolution'
import { usesHostGitForWslLinkedWorktree } from './wsl-linked-worktree-git-routing'

export class ForeignWorktreeLinksError extends Error {
  constructor(readonly worktreePaths: string[]) {
    super(
      `Skipped git worktree prune: ${worktreePaths.join(', ')} ` +
        'were created by the other Git (Windows or WSL), which would delete their metadata.'
    )
    this.name = 'ForeignWorktreeLinksError'
  }
}

/** Throws ForeignWorktreeLinksError instead of pruning, so each caller's failure path applies. */
export async function pruneGitWorktrees(
  options: GitExecOptions,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (platform === 'win32') {
    const foreign = await foreignWorktreeLinks(options)
    if (foreign.length > 0) {
      throw new ForeignWorktreeLinksError(foreign)
    }
  }
  await gitExecFileAsync(['worktree', 'prune'], options)
}

async function foreignWorktreeLinks(options: GitExecOptions): Promise<string[]> {
  const runsInWsl =
    !usesHostGitForWslLinkedWorktree(options.cwd, options.wslDistro) &&
    wslDistroForCommand(options.cwd, options.wslDistro) !== null
  const links = await readWorktreeLinks(join(options.cwd, '.git', 'worktrees'))
  return links
    .filter((link) => (runsInWsl ? /^[A-Za-z]:[\\/]/.test(link) : link.startsWith('/')))
    .map((link) => link.replace(/[\\/]\.git$/, ''))
}

/** A checkout whose `.git` is a file (itself linked, or a submodule) reads as having none. */
export async function readWorktreeLinks(adminRoot: string): Promise<string[]> {
  const names = await readdir(adminRoot).catch(() => [])
  const links = await Promise.all(
    names.map((name) =>
      readFile(join(adminRoot, name, 'gitdir'), 'utf8').then(
        (link) => link.trim(),
        () => ''
      )
    )
  )
  return links.filter(Boolean)
}
