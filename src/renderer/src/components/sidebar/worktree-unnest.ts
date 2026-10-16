import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'
import type { SelectedWorktreeReference } from '@/lib/selected-worktree-reference'

// Context-menu and drag clears share one failure toast.
export async function unnestWorktrees(
  references: readonly (SelectedWorktreeReference | null)[],
  updateWorktreeLineage: AppState['updateWorktreeLineage']
): Promise<void> {
  if (references.length === 0) {
    return
  }
  try {
    await Promise.all(
      references.map((reference) => {
        if (!reference) {
          throw new Error('selector_not_found')
        }
        return updateWorktreeLineage(reference, { noParent: true })
      })
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
