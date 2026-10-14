/**
 * Background writers (first-work renames, scan pruning, backfills) back off quietly from a project a
 * WSL move is taking, or one the WSL host now owns: no throw, no data change. They are all periodic
 * or event-driven, so they retry on their own once the move settles.
 *
 * Each check names the row's host: a move only takes local rows, and the same id on another host is
 * a different project. The row's own path stands in for the store when the journal is unreadable.
 */
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { splitWorktreeId } from '../../../shared/worktree/id'
import {
  isLocalWslMoveRow,
  isWslMoveProjectBlocked,
  isWslMoveSourceHost,
  wslMoveProjectRefForWorkspace
} from './wsl-move-scope-guard'

type HostedRow = { connectionId?: string | null; executionHostId?: string | null }

export type WslMoveRepoRow = HostedRow & { id: string; path: string }

export type WslMoveFolderWorkspaceRow = HostedRow & { id: string; folderPath: string }

export function isWslMoveRepoBlocked(repo: WslMoveRepoRow): boolean {
  if (!isWslMoveSourceHost(getRepoExecutionHostId(repo))) {
    return false
  }
  const store = { getRepo: (id: string) => (id === repo.id ? repo : undefined) }
  return isWslMoveProjectBlocked(store, { repoId: repo.id })
}

export function isWslMoveFolderWorkspaceBlocked(folder: WslMoveFolderWorkspaceRow): boolean {
  if (!isLocalWslMoveRow(folder)) {
    return false
  }
  const store = {
    getRepo: () => undefined,
    getFolderWorkspace: (id: string) => (id === folder.id ? folder : undefined)
  }
  return isWslMoveProjectBlocked(store, { folderWorkspaceId: folder.id })
}

/** For a worktree known only by id and host, such as a resolved worktree or its metadata row. */
export function isWslMoveWorktreeBlocked(
  worktreeId: string,
  hostId: string | null | undefined
): boolean {
  if (!isWslMoveSourceHost(hostId)) {
    return false
  }
  const path = splitWorktreeId(worktreeId)?.worktreePath
  const store = { getRepo: () => (path === undefined ? undefined : { path }) }
  return isWslMoveProjectBlocked(store, wslMoveProjectRefForWorkspace(worktreeId))
}
