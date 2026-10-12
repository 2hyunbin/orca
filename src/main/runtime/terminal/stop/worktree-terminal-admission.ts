import type { RuntimeWorkspaceQuerySurface } from '../../workspaces/workspace-query-surface'
import type { OrcaRuntimeWithSleepResolvedWorktreeTerminals } from '../../orca-runtime-sleep-resolved-worktree-terminals'
import { OrcaRuntimeWithResolveTerminalSplitSourceAuthority } from '../../orca-runtime-resolve-terminal-split-source-authority'
import { runtimeWorktreeIdentityKey } from '../../runtime-worktree-path-identity'
import { WORKTREE_TERMINALS_SLEEPING_ERROR } from '../../worktree-terminals-sleeping-error'
import type { WorktreeTerminalMutationKind } from '../../worktree-terminal-mutation-lock'
import type { RuntimeWorktreeTerminalSleepResult } from '../../../../shared/runtime-types'

export abstract class WorktreeTerminalAdmission extends OrcaRuntimeWithResolveTerminalSplitSourceAuthority {
  protected abstract resolveWorktreeSelector(
    ...args: Parameters<RuntimeWorkspaceQuerySurface['resolveWorktreeSelector']>
  ): ReturnType<RuntimeWorkspaceQuerySurface['resolveWorktreeSelector']>

  protected abstract sleepResolvedWorktreeTerminals(
    ...args: Parameters<
      OrcaRuntimeWithSleepResolvedWorktreeTerminals['sleepResolvedWorktreeTerminals']
    >
  ): ReturnType<OrcaRuntimeWithSleepResolvedWorktreeTerminals['sleepResolvedWorktreeTerminals']>

  async sleepTerminalsForWorktree(
    worktreeSelector: string
  ): Promise<RuntimeWorktreeTerminalSleepResult> {
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const existing = this.terminalSleepByWorktreeId.get(worktree.id)
    if (existing) {
      return await existing
    }

    const sleeping = this.sleepResolvedWorktreeTerminals(worktree)
    this.terminalSleepByWorktreeId.set(worktree.id, sleeping)
    try {
      return await sleeping
    } finally {
      if (this.terminalSleepByWorktreeId.get(worktree.id) === sleeping) {
        this.terminalSleepByWorktreeId.delete(worktree.id)
      }
    }
  }

  async acquireWorktreeTerminalSpawn(
    worktreeId?: string,
    opts: { refuseSleptWorktree?: boolean } = {}
  ): Promise<() => void> {
    if (!worktreeId) {
      return () => {}
    }
    const release = await this.acquireWorktreeTerminalMutation(worktreeId, 'shared')
    const key = runtimeWorktreeIdentityKey(worktreeId)
    const sleepState = this.terminalSleepStateByWorktreeId.get(key)
    // Why: re-checked under the lock, since a sleep can commit while an automatic spawn waits for it.
    if (sleepState && opts.refuseSleptWorktree) {
      release()
      throw new Error(WORKTREE_TERMINALS_SLEEPING_ERROR)
    }
    if (sleepState?.phase === 'sleeping' || sleepState?.phase === 'partial') {
      this.terminalSleepStateByWorktreeId.delete(key)
      this.emitClientEvent({
        type: 'worktreeTerminalSleepState',
        worktreeId: sleepState.worktreeId,
        generation: sleepState.generation,
        phase: 'woken',
        ptyIds: sleepState.ptyIds,
        terminalHandles: sleepState.terminalHandles
      })
    }
    return release
  }

  /** Whether the host itself has put (or is putting) this worktree's terminals to sleep. */
  protected isWorktreeTerminalSleepHeld(worktreeId: string): boolean {
    return this.terminalSleepStateByWorktreeId.has(runtimeWorktreeIdentityKey(worktreeId))
  }

  protected async runWorktreeTerminalMutation<T>(
    worktreeId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    // Why exclusive: adoption reconciles this worktree's terminal records, so
    // it must not interleave with a spawn registering a pty or with a sleep.
    const release = await this.acquireWorktreeTerminalMutation(worktreeId, 'exclusive')
    try {
      return await operation()
    } finally {
      release()
    }
  }

  protected async acquireWorktreeTerminalMutation(
    worktreeId: string,
    kind: WorktreeTerminalMutationKind,
    deadline?: number
  ): Promise<() => void> {
    return await this.terminalMutationLock.acquire(
      runtimeWorktreeIdentityKey(worktreeId),
      kind,
      deadline
    )
  }
}
