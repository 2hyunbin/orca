import type { Repo } from '../../../../shared/repo-types'
import { mergeExternalWorktreeInboxPaths } from '../../../../shared/external-worktree-inbox'

export type ImportedWorktreeCardActionState = {
  pending: boolean
  error: string | null
}

type ImportedWorktreeCardActionDeps = {
  projectId: string
  setCardState: (projectId: string, state: ImportedWorktreeCardActionState | null) => void
  updateRepo: (
    projectId: string,
    updates: Partial<
      Pick<
        Repo,
        | 'externalWorktreeVisibilityPromptDismissedAt'
        | 'externalWorktreeDiscoverySuppressedAt'
        | 'externalWorktreeInboxBaselinePaths'
      >
    >
  ) => Promise<boolean>
  hiddenWorktreePaths?: readonly string[]
  existingBaselinePaths?: readonly string[]
}

export const IMPORTED_WORKTREES_KEEP_HIDDEN_ERROR =
  'Could not keep discovered worktrees hidden. Try again.'

export async function keepImportedWorktreesHiddenCard(
  args: ImportedWorktreeCardActionDeps
): Promise<void> {
  args.setCardState(args.projectId, { pending: true, error: null })
  const updated = await args.updateRepo(args.projectId, {
    externalWorktreeVisibilityPromptDismissedAt: Date.now(),
    externalWorktreeDiscoverySuppressedAt: Date.now(),
    ...(args.hiddenWorktreePaths && args.hiddenWorktreePaths.length > 0
      ? {
          externalWorktreeInboxBaselinePaths: mergeExternalWorktreeInboxPaths(
            args.existingBaselinePaths,
            args.hiddenWorktreePaths
          )
        }
      : {})
  })
  if (!updated) {
    args.setCardState(args.projectId, {
      pending: false,
      error: IMPORTED_WORKTREES_KEEP_HIDDEN_ERROR
    })
    return
  }
  args.setCardState(args.projectId, null)
}
