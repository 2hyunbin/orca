import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { someWorktreeCopy } from '@/lib/resolve-owner'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '../local-structured-session-owner'

type WorkspaceCopy = { hostId?: string; runtimeOwnerEnvironmentId?: string }

function someWorkspaceCopy(
  state: WorktreeOperationRouteState,
  workspaceId: string,
  matches: (copy: WorkspaceCopy) => boolean
): boolean {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type !== 'folder') {
    return someWorktreeCopy(state, workspaceId, matches)
  }
  return (state.folderWorkspaces ?? []).some(
    (folder) =>
      folder.id === scope.folderWorkspaceId &&
      matches({ hostId: folder.executionHostId ?? undefined })
  )
}

/** A paired server republishes what it mirrors from its own servers, so in a pairing cycle it echoes
 *  this app's own workspaces back under their real ids (#33424). This app's runtime already holds
 *  those tabs; the echo would route file reads and closes to a server that lacks the workspace. */
export function isEchoOfThisAppsWorkspace(
  state: WorktreeOperationRouteState,
  workspaceId: string,
  environmentId: string
): boolean {
  // A web client hosts nothing: its `local` rows are its one server's own.
  if (environmentId === LOCAL_STRUCTURED_SESSION_OWNER || isPairedWebClientWindow()) {
    return false
  }
  const serverHostId = toRuntimeExecutionHostId(environmentId)
  // Only a stamped row proves this app hosts it; another server's workspace stays open to every
  // runtime, since a desktop may host browser tabs in it (#31983).
  const ownCopy = someWorkspaceCopy(state, workspaceId, (copy) => {
    const host = parseExecutionHostId(copy.hostId)
    return !!host && host.kind !== 'runtime' && !copy.runtimeOwnerEnvironmentId?.trim()
  })
  return (
    ownCopy &&
    !someWorkspaceCopy(
      state,
      workspaceId,
      (copy) =>
        copy.hostId === serverHostId || copy.runtimeOwnerEnvironmentId?.trim() === environmentId
    )
  )
}
