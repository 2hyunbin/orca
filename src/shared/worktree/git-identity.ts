/** The branch a worktree has checked out, without the `refs/heads/` prefix; '' when there is none. */
export function getWorktreeBranchName(branch: string | null | undefined): string {
  return (branch ?? '').replace(/^refs\/heads\//, '').trim()
}

export function getWorktreeShortHead(head: string | null | undefined): string {
  return (head ?? '').trim().slice(0, 7)
}

/**
 * A checkout of a commit rather than a branch.
 *
 * Why the head check: folder workspaces and SSH-synthesized rows carry both an empty branch and an
 * empty head, so branch-emptiness alone would call them detached.
 */
export function isDetachedHeadCheckout(input: {
  branch?: string | null
  head?: string | null
}): boolean {
  return getWorktreeBranchName(input.branch) === '' && getWorktreeShortHead(input.head) !== ''
}
