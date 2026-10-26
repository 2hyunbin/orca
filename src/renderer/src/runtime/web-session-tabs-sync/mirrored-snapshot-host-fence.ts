import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { findFolderWorkspaceOwner } from '@/lib/folder-workspace-runtime-owner'
import { someWorktreeCopy } from '@/lib/resolve-owner'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '../local-structured-session-owner'
import { webSessionTabsWorktreeRemovalFrame } from './session-tabs-inventory-absence'

function isOwnHost(hostId: string | null | undefined, serverOwner?: string): boolean {
  const host = parseExecutionHostId(hostId)
  return !!host && host.kind !== 'runtime' && !serverOwner?.trim()
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
  const scope = parseWorkspaceKey(workspaceId)
  // Only a stamped row proves this app hosts it; another server's workspace stays open to every
  // runtime, since a desktop may host browser tabs in it (#31983).
  if (scope?.type === 'folder') {
    const own = findFolderWorkspaceOwner(state, scope.folderWorkspaceId)
    return (
      !!own &&
      isOwnHost(own.executionHostId) &&
      !findFolderWorkspaceOwner(state, scope.folderWorkspaceId, serverHostId)
    )
  }
  return (
    someWorktreeCopy(state, workspaceId, (row) =>
      isOwnHost(row.hostId, row.runtimeOwnerEnvironmentId)
    ) &&
    !someWorktreeCopy(
      state,
      workspaceId,
      (row) =>
        row.hostId === serverHostId || row.runtimeOwnerEnvironmentId?.trim() === environmentId
    )
  )
}

/** The echo as a tombstone: the mirror retires what it already took from that server, closing nothing. */
export function withoutEchoedTabs(
  snapshot: RuntimeMobileSessionTabsResult
): RuntimeMobileSessionTabsResult {
  return webSessionTabsWorktreeRemovalFrame(
    snapshot.worktree,
    snapshot.publicationEpoch,
    snapshot.snapshotVersion
  )
}

const MAX_FENCED_ECHOES = 512
const fencedEchoes = new Map<string, { environmentId: string; workspaceId: string }>()

export function recordFencedEcho(environmentId: string, workspaceId: string): void {
  const key = `${environmentId}\u0000${workspaceId}`
  fencedEchoes.delete(key)
  fencedEchoes.set(key, { environmentId, workspaceId })
  if (fencedEchoes.size > MAX_FENCED_ECHOES) {
    const oldest = fencedEchoes.keys().next().value
    if (oldest !== undefined) {
      fencedEchoes.delete(oldest)
    }
  }
}

/** A same-id twin can publish before its own row loads; once the row proves the copy, replay it. */
export function takeEchoesNoLongerFenced(
  state: WorktreeOperationRouteState
): { environmentId: string; workspaceId: string }[] {
  const released: { environmentId: string; workspaceId: string }[] = []
  for (const [key, echo] of fencedEchoes) {
    if (!isEchoOfThisAppsWorkspace(state, echo.workspaceId, echo.environmentId)) {
      fencedEchoes.delete(key)
      released.push(echo)
    }
  }
  return released
}

export function resetFencedEchoesForTests(): void {
  fencedEchoes.clear()
}
