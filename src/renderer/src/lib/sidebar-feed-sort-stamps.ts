import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  worktreeHostMatchOptions,
  worktreeMatchesHost
} from '@/store/slices/worktrees/listing/worktree-host-ownership'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { getFolderWorkspaceHostId } from '../../../shared/folder-workspace-execution-host'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import type { WorkspaceRow } from '../../../shared/sidebar-list/workspace-rows'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { SmartTier } from '../../../shared/sidebar-list/sort-stamps'
import { followDesktopSidebarFeed, onDesktopSidebarFeedInstalled } from './desktop-sidebar-feed'
import { isPairedWebClientWindow } from './desktop-window-chrome'

/** The fields main's stamps write: Recent and Smart order, and the unread flag. */
type SortStamps = {
  isUnread: boolean
  lastActivityAt: number
  smartTier: SmartTier | undefined
  smartAt: number | undefined
}

function stampsOfRow(row: WorkspaceRow): SortStamps | null {
  return row.recentAt === undefined
    ? null
    : {
        isUnread: row.isUnread,
        lastActivityAt: row.recentAt,
        smartTier: row.smartTier,
        smartAt: row.smartAt
      }
}

function sameStamps(a: SortStamps, b: Partial<SortStamps>): boolean {
  return (
    a.isUnread === Boolean(b.isUnread) &&
    a.lastActivityAt === b.lastActivityAt &&
    a.smartTier === b.smartTier &&
    a.smartAt === b.smartAt
  )
}

function withStamps<T extends Partial<SortStamps>>(record: T, stamps: SortStamps): T {
  return sameStamps(stamps, record)
    ? record
    : {
        ...record,
        isUnread: stamps.isUnread,
        lastActivityAt: stamps.lastActivityAt,
        smartTier: stamps.smartTier,
        smartAt: stamps.smartAt
      }
}

type SortStampState = Pick<
  AppState,
  'repos' | 'worktreesByRepo' | 'folderWorkspaces' | 'projectGroups'
>

/** Writes main's stamps onto the window's own records in place; the rest of each record stays. */
export function patchWorkspaceSortStamps<S extends SortStampState>(
  state: S,
  rows: readonly WorkspaceRow[]
): S | Partial<SortStampState> {
  let worktreesByRepo: AppState['worktreesByRepo'] | null = null
  let folderWorkspaces: AppState['folderWorkspaces'] | null = null
  for (const row of rows) {
    const stamps = stampsOfRow(row)
    const hostId = parseExecutionHostId(row.hostId)?.id
    if (!stamps || !hostId) {
      continue
    }
    if (row.kind === 'folder') {
      const scope = parseWorkspaceKey(row.id)
      const current = folderWorkspaces ?? state.folderWorkspaces
      const index = current.findIndex(
        (folder) =>
          scope?.type === 'folder' &&
          folder.id === scope.folderWorkspaceId &&
          getFolderWorkspaceHostId(folder, state.projectGroups) === hostId
      )
      const next = index === -1 ? undefined : withStamps(current[index], stamps)
      if (next && next !== current[index]) {
        folderWorkspaces = current.map((folder, i) => (i === index ? next : folder))
      }
      continue
    }
    const repoRows = (worktreesByRepo ?? state.worktreesByRepo)[row.repoId]
    if (!repoRows) {
      continue
    }
    const options = worktreeHostMatchOptions(state, row.repoId, hostId)
    let changed = false
    const next = repoRows.map((worktree) => {
      if (worktree.id !== row.id || !worktreeMatchesHost(worktree, hostId, options)) {
        return worktree
      }
      const patched = withStamps(worktree, stamps)
      changed ||= patched !== worktree
      return patched
    })
    if (changed) {
      worktreesByRepo = { ...(worktreesByRepo ?? state.worktreesByRepo), [row.repoId]: next }
    }
  }
  if (!worktreesByRepo && !folderWorkspaces) {
    return state
  }
  return {
    ...(worktreesByRepo ? { worktreesByRepo } : {}),
    ...(folderWorkspaces ? { folderWorkspaces } : {})
  }
}

/** The rows whose stamps this install moved; the first install takes every row, as the window's
 *  listing may predate it. */
function rowsWithMovedStamps(
  previous: ReadonlyMap<string, WorkspaceRow> | null,
  next: ReadonlyMap<string, WorkspaceRow>
): WorkspaceRow[] {
  const moved: WorkspaceRow[] = []
  for (const [key, row] of next) {
    const before = previous?.get(key)
    const stamps = stampsOfRow(row)
    if (!stamps || before === row) {
      continue
    }
    const beforeStamps = before ? stampsOfRow(before) : null
    if (!previous || !beforeStamps || !sameStamps(stamps, beforeStamps)) {
      moved.push(row)
    }
  }
  return moved
}

/**
 * Switch point. Main writes this host's sort stamps and announces them to paired clients only:
 * the window's records take them off each feed install, so a stamp never re-lists a repo.
 */
export function followSidebarFeedSortStamps(): () => void {
  if (!ORCA_SIDEBAR_INPUTS_IS_MAIN || isPairedWebClientWindow()) {
    return () => {}
  }
  let previous: ReadonlyMap<string, WorkspaceRow> | null = null
  const detach = onDesktopSidebarFeedInstalled(({ domains }) => {
    const rows = rowsWithMovedStamps(previous, domains.workspaces)
    previous = domains.workspaces
    if (rows.length > 0) {
      useAppStore.setState((state) => patchWorkspaceSortStamps(state, rows))
    }
  })
  // The dock badge and palettes read these records with no sidebar list mounted.
  followDesktopSidebarFeed()
  return detach
}
