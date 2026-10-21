import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  worktreeHostMatchOptions,
  worktreeMatchesHost
} from '@/store/slices/worktrees/listing/worktree-host-ownership'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { getFolderWorkspaceHostId } from '../../../shared/folder-workspace-execution-host'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import type { WorkspaceRow } from '../../../shared/sidebar-list/workspace-rows'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { SmartTier } from '../../../shared/sidebar-list/sort-stamps'
import { followDesktopSidebarFeed, onDesktopSidebarFeedInstalled } from './desktop-sidebar-feed'
import { isPairedWebClientWindow } from './desktop-window-chrome'
import { readSidebarPendingLayer, subscribeSidebarPendingLayer } from './sidebar-pending-layer'
import { targets, type SidebarPendingLayer } from './sidebar-pending-overlay'

/** The fields main's stamps write: Recent and Smart order, and the unread flag. */
type SortStamps = {
  isUnread: boolean | undefined
  lastActivityAt: number
  smartTier: SmartTier | undefined
  smartAt: number | undefined
}

type SortStampState = Pick<
  AppState,
  'repos' | 'worktreesByRepo' | 'detectedWorktreesByRepo' | 'folderWorkspaces' | 'projectGroups'
>

function stampsOfRow(row: WorkspaceRow, pending: SidebarPendingLayer): SortStamps | null {
  if (row.recentAt === undefined) {
    return null
  }
  const hostId = parseExecutionHostId(row.hostId)?.id ?? null
  // The window's own unanswered mark read/unread stands until main shows it.
  const unreadPending = pending.writes.some(
    (write) => 'isUnread' in write.values && targets(write, row.id, hostId)
  )
  return {
    isUnread: unreadPending ? undefined : row.isUnread,
    lastActivityAt: row.recentAt,
    smartTier: row.smartTier,
    smartAt: row.smartAt
  }
}

function withStamps<T extends { isUnread: boolean } & Partial<SortStamps>>(
  record: T,
  stamps: SortStamps
): T {
  const isUnread = stamps.isUnread ?? record.isUnread
  return isUnread === record.isUnread &&
    stamps.lastActivityAt === record.lastActivityAt &&
    stamps.smartTier === record.smartTier &&
    stamps.smartAt === record.smartAt
    ? record
    : {
        ...record,
        isUnread,
        lastActivityAt: stamps.lastActivityAt,
        smartTier: stamps.smartTier,
        smartAt: stamps.smartAt
      }
}

function patchRepoRows<T extends AppState['worktreesByRepo'][string][number]>(
  rows: readonly T[],
  id: string,
  hostId: ExecutionHostId,
  options: ReturnType<typeof worktreeHostMatchOptions>,
  stamps: SortStamps
): T[] | null {
  let changed = false
  const next = rows.map((worktree) => {
    if (worktree.id !== id || !worktreeMatchesHost(worktree, hostId, options)) {
      return worktree
    }
    const patched = withStamps(worktree, stamps)
    changed ||= patched !== worktree
    return patched
  })
  return changed ? next : null
}

/** Writes main's stamps onto the window's own records in place; the rest of each record stays.
 *  Idempotent, so it re-runs whenever a listing replaces those records. */
export function patchWorkspaceSortStamps<S extends SortStampState>(
  state: S,
  rows: Iterable<WorkspaceRow>,
  pending: SidebarPendingLayer
): S | Partial<SortStampState> {
  let worktreesByRepo = state.worktreesByRepo
  let detectedWorktreesByRepo = state.detectedWorktreesByRepo
  let folderWorkspaces = state.folderWorkspaces
  for (const row of rows) {
    const stamps = stampsOfRow(row, pending)
    const hostId = parseExecutionHostId(row.hostId)?.id
    if (!stamps || !hostId) {
      continue
    }
    if (row.kind === 'folder') {
      const scope = parseWorkspaceKey(row.id)
      const current = folderWorkspaces
      const index = current.findIndex(
        (folder) =>
          scope?.type === 'folder' &&
          folder.id === scope.folderWorkspaceId &&
          getFolderWorkspaceHostId(folder, state.projectGroups) === hostId
      )
      const found = index === -1 ? undefined : current[index]
      const next = found && withStamps(found, stamps)
      if (next && next !== found) {
        folderWorkspaces = current.map((folder, i) => (i === index ? next : folder))
      }
      continue
    }
    const options = worktreeHostMatchOptions(state, row.repoId, hostId)
    const listed = worktreesByRepo[row.repoId]
    const nextListed = listed && patchRepoRows(listed, row.id, hostId, options, stamps)
    if (nextListed) {
      worktreesByRepo = { ...worktreesByRepo, [row.repoId]: nextListed }
    }
    // The Activity page reads the detected listing.
    const detected = detectedWorktreesByRepo[row.repoId]
    const nextDetected =
      detected && patchRepoRows(detected.worktrees, row.id, hostId, options, stamps)
    if (detected && nextDetected) {
      detectedWorktreesByRepo = {
        ...detectedWorktreesByRepo,
        [row.repoId]: { ...detected, worktrees: nextDetected }
      }
    }
  }
  const changes: Partial<SortStampState> = {
    ...(worktreesByRepo !== state.worktreesByRepo ? { worktreesByRepo } : {}),
    ...(detectedWorktreesByRepo !== state.detectedWorktreesByRepo
      ? { detectedWorktreesByRepo }
      : {}),
    ...(folderWorkspaces !== state.folderWorkspaces ? { folderWorkspaces } : {})
  }
  return Object.keys(changes).length > 0 ? changes : state
}

/**
 * Switch point. Main writes this host's sort stamps and announces them to paired clients only:
 * the window's records take them off main's last installed rows, so a stamp never re-lists a
 * repo, and a listing that read main before a stamp is corrected as it lands.
 * The cleanup that moves these records' readers onto the feed deletes this module.
 */
export function followSidebarFeedSortStamps(): () => void {
  if (!ORCA_SIDEBAR_INPUTS_IS_MAIN || isPairedWebClientWindow()) {
    return () => {}
  }
  let installed: ReadonlyMap<string, WorkspaceRow> | null = null
  const apply = (): void => {
    if (installed) {
      const rows = installed.values()
      useAppStore.setState((state) =>
        patchWorkspaceSortStamps(state, rows, readSidebarPendingLayer())
      )
    }
  }
  const detachInstall = onDesktopSidebarFeedInstalled(({ domains }) => {
    installed = domains.workspaces
    apply()
  })
  // A settled write hands its field back to main's value.
  const detachPending = subscribeSidebarPendingLayer(apply)
  const detachStore = useAppStore.subscribe((state, previous) => {
    if (
      state.worktreesByRepo !== previous.worktreesByRepo ||
      state.detectedWorktreesByRepo !== previous.detectedWorktreesByRepo ||
      state.folderWorkspaces !== previous.folderWorkspaces
    ) {
      apply()
    }
  })
  // The dock badge and palettes read these records with no sidebar list mounted.
  followDesktopSidebarFeed()
  return () => {
    detachInstall()
    detachPending()
    detachStore()
  }
}
