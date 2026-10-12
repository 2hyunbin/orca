import { OrcaRuntimeWithTransitionGraphReloadToTerminalState } from '../../orca-runtime-transition-graph-reload-to-terminal-state'
import { getExplicitWorktreeIdSelector } from '../../runtime-worktree-selection'
import { WORKTREE_ID_SEPARATOR } from '../../../../shared/worktree/id'
import { WorktreeIdRequiresFullPathError } from '../../runtime-worktree-lineage-resolution'

export abstract class TerminalWorkspaceIdValidation extends OrcaRuntimeWithTransitionGraphReloadToTerminalState {
  protected getValidatedExplicitWorktreeIdSelector(selector: string | undefined): string | null {
    const worktreeId = getExplicitWorktreeIdSelector(selector)
    if (
      worktreeId &&
      !worktreeId.includes(WORKTREE_ID_SEPARATOR) &&
      this.store?.getRepo(worktreeId)
    ) {
      // Why: a registered repo id is a known-invalid worktree id; reject early before fast paths or Git/SSH scans hide the mistake.
      throw new WorktreeIdRequiresFullPathError()
    }
    return worktreeId
  }
}
