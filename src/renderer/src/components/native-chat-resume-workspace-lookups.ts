import { getLineageInputs } from './sidebar/visible-worktree-indexes'
import { useMemo } from 'react'
import { getSidebarLineageAncestors } from '../../../shared/sidebar-list/worktree-lineage-projection'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { useAppStore } from '../store'
import type { ResumeWorkspaceGroup } from './native-chat-resume-on-restart-grouping'

// Store lookups the resume tree makes for its workspaces, each on the workspace's own host.

/** The store's row for a workspace on its own host; folder workspaces included. Stable per row. */
export function useWorkspaceWorktree(workspaceId: string, hostId: ExecutionHostId | undefined) {
  return useAppStore((store) => store.getKnownWorktreeById(workspaceId, hostId))
}

/**
 * The repo owning each workspace, as one narrow subscription.
 *
 * Selected as a joined string rather than a map so the selector returns a PRIMITIVE: a fresh object
 * or array would fail the equality check on every store change and re-render the whole list.
 * Keyed by the group itself: the same workspace id can be listed on two machines.
 */
export function useRepoIdByWorkspace(
  workspaces: readonly ResumeWorkspaceGroup[]
): (group: ResumeWorkspaceGroup) => string | null {
  const ids = workspaces.map((group) => group.workspaceId)
  const hosts = workspaces.map((group) => group.candidates[0]?.executionHostId)
  const joined = useAppStore((store) =>
    ids.map((id, index) => store.getKnownWorktreeById(id, hosts[index])?.repoId ?? '').join('\0')
  )
  const repoIds = joined.split('\0')
  return (group) => {
    const index = workspaces.indexOf(group)
    const repoId = index === -1 ? '' : (repoIds[index] ?? '')
    return repoId === '' ? null : repoId
  }
}

/** Each workspace's lineage ancestors, nearest first, by the sidebar's own nesting rule. */
export function useLineageAncestors(
  workspaces: readonly ResumeWorkspaceGroup[]
): (group: ResumeWorkspaceGroup) => readonly string[] {
  const inputs = useAppStore(getLineageInputs)
  const ancestors = useMemo(() => {
    const rows = inputs.worktreeMap
    return new Map(
      workspaces.map((group) => {
        // Why: a row with no host id (older metadata) is still the chat's workspace.
        const target =
          rows.get(
            composeWorktreeHostIdentity(group.candidates[0]?.executionHostId, group.workspaceId)
          ) ?? rows.get(composeWorktreeHostIdentity(undefined, group.workspaceId))
        const parents = target ? getSidebarLineageAncestors(target, inputs.lineageById, rows) : []
        return [group, parents.map((parent) => parent.id)]
      })
    )
  }, [workspaces, inputs])
  return (group) => ancestors.get(group) ?? []
}
