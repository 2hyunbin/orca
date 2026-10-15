import { isFolderRepo } from '../repo-kind'
import type { Repo } from '../repo-types'
import type { Worktree } from '../worktree/types'
import { isDetachedHeadCheckout } from '../worktree/git-identity'

// What KIND of workspace a row is, as the Workspace options filters read it. The desktop sidebar
// asks these of its own worktrees; a host asks them of the rows it serves a phone.

export function isAutomationGeneratedWorkspace(
  worktree: Pick<Worktree, 'automationProvenance'>
): boolean {
  return worktree.automationProvenance?.kind === 'created-by-automation'
}

export function isCliCreatedWorkspace(worktree: Pick<Worktree, 'cliProvenance'>): boolean {
  return worktree.cliProvenance?.kind === 'created-by-cli'
}

export function isDetachedHeadWorkspace(worktree: Pick<Worktree, 'branch' | 'head'>): boolean {
  return isDetachedHeadCheckout(worktree)
}

/** Keeps provisioned roots visible because they are the recipe-created workspace, not a source-repo row. */
export function isDefaultBranchWorkspace(
  worktree: Pick<Worktree, 'isMainWorktree' | 'ephemeralVmCheckoutMode' | 'branch'>,
  repo: Pick<Repo, 'kind'> | undefined
): boolean {
  if (!worktree.isMainWorktree || worktree.ephemeralVmCheckoutMode === 'provisioned-root') {
    return false
  }
  // Why: a folder project's root is its default workspace but has no branch; on a git repo an
  // empty branch means detached HEAD or an offline SSH row, which stay visible.
  return worktree.branch.trim() !== '' || (repo !== undefined && isFolderRepo(repo))
}
