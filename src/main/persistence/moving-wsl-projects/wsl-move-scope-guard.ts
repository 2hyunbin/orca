/**
 * Where the WSL move fence takes effect in this build (design, section 4.3): projects a move is
 * taking are read-only and get no new terminals, and projects the WSL host now owns are not listed.
 * One answer for every IPC and RPC entry point, so no path can edit a project mid-move.
 *
 * Held in memory: loaded at startup, before any handler runs, and reloaded on every journal write,
 * since only this process writes the journal. Spawns and list calls never touch the disk for it.
 * A spawn already past this check when the fence lands is caught by the move itself: the gate runs
 * again under the fence, and the exit proof refuses any live session in scope.
 */
import { resolve } from 'node:path'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { isWslUncPath } from '../../../shared/wsl-paths'
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

/** Only the project paths, read when the journal is unreadable. */
type ProjectStore = {
  getRepo: (repoId: string) => { path: string } | undefined
  getFolderWorkspace: (folderWorkspaceId: string) => { folderPath: string } | undefined
}

/** An unreadable journal fences every WSL project and hides none: never edit, never lose a row. */
type FenceView = { readable: true; state: WslMoveFenceState } | { readable: false }

let loaded: { userDataKey: string; view: FenceView } | null = null

// `app.setName` can respell the same folder; Windows paths compare case-insensitively.
function userDataKey(userDataPath: string): string {
  const resolved = resolve(userDataPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
let stopFollowing: (() => void) | null = null

/** Startup, before handlers register. A move must not fence anything until this has run. */
export function loadWslMoveFence(userDataPath: string): void {
  loaded = { userDataKey: userDataKey(userDataPath), view: readFence(userDataPath) }
  stopFollowing ??= onWslMoveJournalChange((changedPath) => {
    if (loaded?.userDataKey === userDataKey(changedPath)) {
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

/**
 * True while a move is taking the project, or once the WSL host owns it. Only an unreadable journal
 * needs the store, to tell WSL projects apart; with none to ask, it blocks.
 */
export function isWslMoveProjectBlocked(
  store: ProjectStore | undefined,
  ref: WslMoveProjectRef | null
): boolean {
  const fence = loaded?.view
  if (!ref || !fence) {
    return false
  }
  if (fence.readable) {
    return inScope(fence.state.fenced, ref) || inScope(fence.state.hidden, ref)
  }
  return !store || isWslUncPath(projectPath(store, ref) ?? '')
}

export function isWslMoveWorkspaceBlocked(
  store: ProjectStore | undefined,
  workspaceId: string | null | undefined
): boolean {
  return !!workspaceId && isWslMoveProjectBlocked(store, wslMoveProjectRefForWorkspace(workspaceId))
}

export function assertWslMoveWorkspaceWritable(
  store: ProjectStore | undefined,
  workspaceId: string | null | undefined
): void {
  if (isWslMoveWorkspaceBlocked(store, workspaceId)) {
    throw new WslMoveProjectFencedError()
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
