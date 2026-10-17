import { OrcaRuntimeWithStopExactTerminalsForWorktree } from './worktree-terminal-stop-targets'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type { Repo } from '../../../../shared/repo-types'

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

export abstract class OrcaRuntimeWithStopTerminalsForProject extends OrcaRuntimeWithStopExactTerminalsForWorktree {
  /**
   * Stops every terminal this host runs for a project, found through its own PTY table rather
   * than a client's workspace list, which can be unhydrated or hide workspaces.
   */
  async stopTerminalsForProject(
    repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>,
    options: { deadline?: number } = {}
  ): Promise<{ stopped: number }> {
    // Why: after a restart, surviving daemon sessions are in the provider inventory before ptysById.
    try {
      const resolvedWorktrees = [...(await this.getResolvedWorktreeMap()).values()]
      await this.refreshPtyWorktreeRecordsFromController(resolvedWorktrees, null, options.deadline)
    } catch (error) {
      console.warn('[runtime] project terminal inventory refresh failed', error)
    }
    // Why not the row's stamp: a `runtime:` stamp is how paired clients address a project that runs here.
    const host = parseExecutionHostId(getRepoExecutionHostId(repo))
    const fence = { resolvedConnectionId: host?.kind === 'ssh' ? host.targetId : null }
    let stopped = 0
    for (const id of listProjectTerminalWorktreeIds(repo.id, this.leaves, this.ptysById)) {
      const opts = { resolvedWorktreeId: id, ...fence, ...options }
      stopped += (await this.stopTerminalsForWorktree(`id:${id}`, opts)).stopped
    }
    return { stopped }
  }
}
