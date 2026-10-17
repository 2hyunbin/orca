import { OrcaRuntimeWithStopExactTerminalsForWorktree } from './worktree-terminal-stop-targets'
import { getRepoSshConnectionId } from '../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type { Repo } from '../../../../shared/repo-types'

const PROJECT_INVENTORY_REFRESH_BUDGET_MS = 3_000

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
    // Bounded so a slow worktree scan cannot spend the budget the known PTYs' stops need.
    const refreshDeadline = Math.min(
      options.deadline ?? Infinity,
      Date.now() + PROJECT_INVENTORY_REFRESH_BUDGET_MS
    )
    const projectWorktreeIds = new Set<string>()
    const refresh = (async () => {
      const resolvedWorktrees = [...(await this.getResolvedWorktreeMap()).values()]
      for (const worktree of resolvedWorktrees) {
        if (worktree.repoId === repo.id) {
          projectWorktreeIds.add(worktree.id)
        }
      }
      await this.refreshPtyWorktreeRecordsFromController(resolvedWorktrees, null, refreshDeadline)
    })().catch((error: unknown) => {
      console.warn('[runtime] project terminal inventory refresh failed', error)
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      refresh,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, refreshDeadline - Date.now()))
      })
    ])
    clearTimeout(timer)
    // Why not the row's stamp: a `runtime:` stamp is how paired clients address a project that runs
    // here, natively or over its nested SSH connection.
    const fence = { resolvedConnectionId: getRepoSshConnectionId(repo) }
    let stopped = 0
    for (const id of listProjectTerminalWorktreeIds(repo.id, this.leaves, this.ptysById)) {
      projectWorktreeIds.add(id)
    }
    for (const id of projectWorktreeIds) {
      const opts = { resolvedWorktreeId: id, ...fence, ...options }
      // Why exclusive: it waits out a spawn that holds the shared lease, so its PTY is registered and stopped.
      stopped += await this.runWorktreeTerminalMutation(
        id,
        async () => (await this.stopTerminalsForWorktree(`id:${id}`, opts)).stopped
      )
    }
    return { stopped }
  }
}
