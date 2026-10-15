import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import {
  buildWorkspaceDetailLinks,
  buildWorkspaceOrigin,
  workspaceNotes
} from '../worktree/workspace-details-model'
import type { Worktree } from '../worktree/workspace-list-types'
import { useWorkspaceDetailExtras } from './use-workspace-detail-extras'
import { getWorktreeGitIdentityDisplay } from '../../../src/shared/worktree/git-identity-display'
import { WorkspaceDetailsHeader, WorkspaceDetailsSection } from './workspace-details-section'

/** The long-press sheet's heading and details for `row`: what the row carries, filled in by the host's reads. */
export function WorkspaceActionDetails({
  row,
  client,
  onOpenLink
}: {
  row: Worktree | null
  client: RpcOperationSender | null
  onOpenLink: (url: string) => void
}) {
  const extras = useWorkspaceDetailExtras(row, client)
  if (!row) {
    return null
  }
  const identity = getWorktreeGitIdentityDisplay({ branch: row.branch })
  return (
    <>
      <WorkspaceDetailsHeader
        name={row.displayName || row.repo}
        branch={identity?.kind === 'branch' ? identity.branchName : null}
        origin={buildWorkspaceOrigin(row, extras.origin)}
      />
      <WorkspaceDetailsSection
        links={buildWorkspaceDetailLinks(row, extras.review)}
        notes={workspaceNotes(row)}
        onOpenLink={onOpenLink}
        // A folder's sheet has no actions, so it says when there is nothing to show.
        emptyText={row.workspaceKind === 'folder-workspace' ? 'No links or notes' : undefined}
      />
    </>
  )
}
