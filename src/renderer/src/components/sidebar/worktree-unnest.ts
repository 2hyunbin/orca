import type { Worktree } from '../../../../shared/worktree/types'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'

// Context-menu and drag clears share one failure toast.
export async function unnestWorktrees(
  worktrees: readonly Pick<Worktree, 'id' | 'identity'>[],
  updateWorktreeLineage: AppState['updateWorktreeLineage']
): Promise<void> {
  if (worktrees.length === 0) {
    return
  }
  try {
    await Promise.all(
      worktrees.map((row) =>
        updateWorktreeLineage(row.id, { identity: row.identity, noParent: true })
      )
    )
  } catch (err) {
    console.error('Failed to unnest workspace:', err)
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeList.failedUnnestWorkspace',
        'Failed to unnest workspace'
      )
    )
  }
}
