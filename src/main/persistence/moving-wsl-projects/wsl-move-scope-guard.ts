/**
 * Where the WSL move fence takes effect in this build (design, section 4.3): projects a move is
 * taking are read-only and get no new terminals, and projects the WSL host now owns are not listed.
 * One answer for every IPC and RPC entry point, so no path can edit a project mid-move.
 *
 * Held in memory: loaded at startup, before any handler runs, and reloaded on every journal write,
 * since only this process writes the journal. Spawns and list calls never touch the disk for it.
 */
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { isWslUncPath } from '../../../shared/wsl-paths'
import type { Store } from '../../persistence'
import { onWslMoveJournalChange } from './wsl-move-cutover-journal'
import { resolveWslMoveFence, type WslMoveFenceState } from './wsl-move-fence'

export type WslMoveProjectRef = { repoId: string } | { folderWorkspaceId: string }

export class WslMoveProjectFencedError extends Error {
  readonly code = 'wsl_move_in_progress'
  constructor() {
    super('This project is moving to its WSL host. Try again when the move finishes.')
    this.name = 'WslMoveProjectFencedError'
  }
}

type ProjectStore = Pick<Store, 'getRepo' | 'getFolderWorkspace'>

/** An unreadable journal fences every WSL project and hides none: never edit, never lose a row. */
type FenceView = { readable: true; state: WslMoveFenceState } | { readable: false }

let loaded: { userDataPath: string; view: FenceView } | null = null
let stopFollowing: (() => void) | null = null

/** Startup, before handlers register. A move must not fence anything until this has run. */
export function loadWslMoveFence(userDataPath: string): void {
  loaded = { userDataPath, view: readFence(userDataPath) }
  stopFollowing ??= onWslMoveJournalChange((changedPath) => {
    if (loaded?.userDataPath === changedPath) {
      loaded.view = readFence(changedPath)
    }
  })
}

export function isWslMoveFenceLoaded(): boolean {
  return loaded !== null
}

export function resetWslMoveFenceForTests(): void {
  stopFollowing?.()
  stopFollowing = null
  loaded = null
}

function readFence(userDataPath: string): FenceView {
  try {
    return { readable: true, state: resolveWslMoveFence(userDataPath) }
  } catch (error) {
    console.warn('[wsl-move] Journal unreadable; keeping WSL projects read-only:', error)
    return { readable: false }
  }
}

/** The project a terminal's or session's workspace key belongs to. */
export function wslMoveProjectRefForWorkspace(workspaceId: string): WslMoveProjectRef | null {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    return { folderWorkspaceId: scope.folderWorkspaceId }
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return repoId && repoId !== worktreeId ? { repoId } : null
}

function inScope(scope: WslMoveFenceState['fenced'], ref: WslMoveProjectRef): boolean {
  return 'repoId' in ref
    ? scope.repoIds.has(ref.repoId)
    : scope.folderWorkspaceIds.has(ref.folderWorkspaceId)
}

function projectPath(store: ProjectStore, ref: WslMoveProjectRef): string | undefined {
  return 'repoId' in ref
    ? store.getRepo(ref.repoId)?.path
    : store.getFolderWorkspace(ref.folderWorkspaceId)?.folderPath
}

/** Throws while a move is taking the project, or once the WSL host owns it. */
export function assertWslMoveProjectWritable(
  store: ProjectStore,
  ref: WslMoveProjectRef | null
): void {
  const fence = loaded?.view
  if (!ref || !fence) {
    return
  }
  const blocked = fence.readable
    ? inScope(fence.state.fenced, ref) || inScope(fence.state.hidden, ref)
    : isWslUncPath(projectPath(store, ref) ?? '')
  if (blocked) {
    throw new WslMoveProjectFencedError()
  }
}

export function assertWslMoveWorkspaceWritable(
  store: ProjectStore,
  workspaceId: string | null | undefined
): void {
  if (workspaceId) {
    assertWslMoveProjectWritable(store, wslMoveProjectRefForWorkspace(workspaceId))
  }
}

/** Rows the WSL host owns stay in the profile for a downgrade; this build lists the host instead. */
export function withoutWslMovedProjects<T>(rows: T[], toRef: (row: T) => WslMoveProjectRef): T[] {
  const fence = loaded?.view
  if (rows.length === 0 || !fence?.readable) {
    return rows
  }
  const { hidden } = fence.state
  if (hidden.repoIds.size === 0 && hidden.folderWorkspaceIds.size === 0) {
    return rows
  }
  return rows.filter((row) => !inScope(hidden, toRef(row)))
}
