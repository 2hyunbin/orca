import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'

/** Distinct worktree ids of a project that still hold a pane or PTY on this host. */
export function listProjectTerminalWorktreeIds(
  repoId: string,
  leaves: ReadonlyMap<string, { worktreeId: string; ptyId: string | null }>,
  ptys: ReadonlyMap<string, { worktreeId: string }>
): string[] {
  const worktreeIds = new Set<string>()
  for (const leaf of leaves.values()) {
    if (leaf.ptyId && getRepoIdFromWorktreeId(leaf.worktreeId) === repoId) {
      worktreeIds.add(leaf.worktreeId)
    }
  }
  for (const pty of ptys.values()) {
    if (getRepoIdFromWorktreeId(pty.worktreeId) === repoId) {
      worktreeIds.add(pty.worktreeId)
    }
  }
  return [...worktreeIds]
}
