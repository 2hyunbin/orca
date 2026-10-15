import { isFolderRepo } from '../repo-kind'
import type { Repo } from '../repo-types'
import type { RuntimeWorktreePsSummary } from '../runtime-worktree-contracts'
import type { Worktree } from '../worktree/types'
import { getWorktreeBranchName, getWorktreeShortHead } from '../worktree/git-identity'

// What KIND of workspace a row is, as the Workspace options filters read it.

export function isAutomationGeneratedWorkspace(
  worktree: Pick<Worktree, 'automationProvenance'>
): boolean {
  return worktree.automationProvenance?.kind === 'created-by-automation'
}

export function isCliCreatedWorkspace(worktree: Pick<Worktree, 'cliProvenance'>): boolean {
  return worktree.cliProvenance?.kind === 'created-by-cli'
}

/**
 * A checkout of a commit rather than a branch.
 *
 * Why the head check: folder workspaces and SSH-synthesized rows carry both an empty branch and an
 * empty head, so branch-emptiness alone would call them detached.
 */
export function isDetachedHeadWorkspace(worktree: {
  branch?: string | null
  head?: string | null
}): boolean {
  return getWorktreeBranchName(worktree.branch) === '' && getWorktreeShortHead(worktree.head) !== ''
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

/** What a host stamps on each worktree.ps row, so a phone's filters match this host's sidebar. */
export function getWorkspaceRowKindFacts(
  worktree: Pick<
    Worktree,
    | 'isMainWorktree'
    | 'ephemeralVmCheckoutMode'
    | 'branch'
    | 'head'
    | 'automationProvenance'
    | 'cliProvenance'
  >,
  repo: Pick<Repo, 'kind'> | undefined
): Pick<
  RuntimeWorktreePsSummary,
  'defaultBranch' | 'automationCreated' | 'cliCreated' | 'detachedHead'
> {
  return {
    defaultBranch: isDefaultBranchWorkspace(worktree, repo),
    ...(isAutomationGeneratedWorkspace(worktree) ? { automationCreated: true } : {}),
    ...(isCliCreatedWorkspace(worktree) ? { cliCreated: true } : {}),
    ...(isDetachedHeadWorkspace(worktree) ? { detachedHead: true } : {})
  }
}
