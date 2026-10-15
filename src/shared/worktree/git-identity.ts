/** The branch a worktree has checked out, without the `refs/heads/` prefix; '' when there is none. */
export function getWorktreeBranchName(branch: string | null | undefined): string {
  return (branch ?? '').replace(/^refs\/heads\//, '').trim()
}

export function getWorktreeShortHead(head: string | null | undefined): string {
  return (head ?? '').trim().slice(0, 7)
}
