import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import {
  buildWorkspaceDetailLinks,
  buildWorkspaceOrigin,
  workspaceNotes
} from '../worktree/workspace-details-model'
import type { Worktree } from '../worktree/workspace-list-types'
import { useWorkspaceDetailExtras } from './use-workspace-detail-extras'
import { WorkspaceDetailsSection } from './workspace-details-section'

/** The long-press sheet's details for `row`: what the row carries, filled in by the host's reads. */
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
  const isFolder = row.workspaceKind === 'folder-workspace'
  return (
    <WorkspaceDetailsSection
      links={buildWorkspaceDetailLinks(row, extras.review)}
      origin={buildWorkspaceOrigin(row, extras.origin)}
      notes={workspaceNotes(row)}
      ports={extras.ports ?? null}
      onOpenLink={onOpenLink}
      // Only a folder's sheet can be otherwise empty; ports are named only once the scan said none.
      emptyText={
        isFolder && extras.ports !== undefined
          ? extras.ports
            ? 'No links, notes or live ports'
            : 'No links or notes'
          : undefined
      }
    />
  )
}
