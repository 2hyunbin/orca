import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { parseRoutableExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { getKnownExecutionHostIdForWorktree } from './worktree-runtime-owner'
import { runtimeTargetForWorkspaceOwner } from './resolve-owner'
import {
  getConnectionIdForWorktreeCopy,
  getConnectionIdFromState
} from './connection-owner-resolution'

/**
 * One host's copy of a worktree, for git work whose answer is written back to the store. Worktree
 * ids are `repoId::path` and repeat across hosts, so the transport, the SSH target and the copy
 * the answer lands on must all come from this one resolution.
 */
export type WorktreeGitCopy = {
  readonly worktreeId: string
  /** The copy's host; null only when no row places it, which leaves a same-id twin untouched. */
  readonly hostId: ExecutionHostId | null
  readonly connectionId: string | undefined
  readonly transport: RuntimeClientTarget
}

function placedHostId(state: AppState, worktreeId: string): ExecutionHostId | null {
  return (
    parseRoutableExecutionHostId(getKnownExecutionHostIdForWorktree(state, worktreeId))?.id ?? null
  )
}

/**
 * Resolves `worktreeId` on `hostId`, or on the selected copy when no host is named. Null when the
 * owner's transport is unknown, so callers skip the call instead of reading the path locally.
 */
export function resolveWorktreeGitCopy(
  state: AppState,
  worktreeId: string,
  hostId?: ExecutionHostId | null
): WorktreeGitCopy | null {
  const copyHostId = hostId ?? placedHostId(state, worktreeId)
  const transport = runtimeTargetForWorkspaceOwner(state, {
    workspaceId: worktreeId,
    ...(copyHostId ? { hostId: copyHostId } : {})
  })
  if (!transport) {
    return null
  }
  // Why the copy lookup: the bare-id one answers undefined for a twin, which a caller would
  // otherwise turn into a local `git status` of the SSH copy's path.
  const connectionId =
    getConnectionIdFromState(state, worktreeId) ??
    (copyHostId ? getConnectionIdForWorktreeCopy(state, worktreeId, copyHostId) : undefined)
  return {
    worktreeId,
    hostId: copyHostId,
    connectionId: connectionId ?? undefined,
    transport
  }
}

/** {@link resolveWorktreeGitCopy} against the live store. */
export function resolveWorktreeGitCopyNow(
  worktreeId: string,
  hostId?: ExecutionHostId | null
): WorktreeGitCopy | null {
  return resolveWorktreeGitCopy(useAppStore.getState(), worktreeId, hostId)
}

/** The selected copy's host, for a callback that must keep answering for it after a switch. */
export function useWorktreeGitCopyHostId(worktreeId: string | null): ExecutionHostId | null {
  return useAppStore((state) => (worktreeId ? placedHostId(state, worktreeId) : null))
}
