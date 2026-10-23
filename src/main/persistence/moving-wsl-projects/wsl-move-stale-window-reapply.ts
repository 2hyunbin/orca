/**
 * A window hydrated before a move's rewrite still holds the old state and writes it back: its
 * focus (the session's active workspace, the UI's last-active worktree) at any time, and its whole
 * host partition at unload. Two corrections, neither touching the journal or its ledger:
 * - Focus, for every committed move, at each startup and after each unload checkpoint. It only
 *   ever points a moved local project at the host, so no later user choice is undone.
 * - The additive rewrites (UI host copies and visible hosts, the host partition's seed), at each
 *   unload of a window that was open when the move was rewritten, and a last time when its
 *   document is replaced. Re-applied after that they would undo a user's choice, such as hiding
 *   the WSL host.
 */
import { WSL_MOVE_CUTOVER_PHASES } from '../../../shared/wsl-move/wsl-move-cutover'
import { wslHostsGateOpen } from '../../wsl/wsl-host-gate'
import type { Store } from '../loading-store/store'
import { scanWslMoveCutovers } from './wsl-move-cutover-journal'
import { wslMoveDesktopRewriteContext } from './wsl-move-desktop-rewrite'
import {
  applyWslMoveHostSessionSeed,
  applyWslMoveSessionFocus,
  listWslMoveRewritesUnderOpenWindow,
  takeWslMoveRewritesUnderOpenWindow
} from './wsl-move-main-rewrite-stores'
import { wslMoveRewriteScope, type WslMoveRewriteScope } from './wsl-move-rewrite-scope'
import {
  rewriteWslMoveUiRouting,
  wslMoveLastActiveWorktreeUpdate
} from './wsl-move-ui-routing-rewrite'

export type WslMoveStaleWindowProfile = Pick<
  Store,
  'getUI' | 'updateUI' | 'getWorkspaceSession' | 'patchWorkspaceSession' | 'setWorkspaceSession'
>

const COMMITTED_PHASE_INDEX = WSL_MOVE_CUTOVER_PHASES.indexOf('destination-committed')

type Warn = (message: string) => void
const defaultWarn: Warn = (message) => console.warn(message)

/** Never throws; a no-op with the gate closed or no committed move. Returns how many writes it made. */
export function reapplyWslMoveFocusRewrites(
  userDataPath: string,
  profile: WslMoveStaleWindowProfile,
  warn: Warn = defaultWarn
): number {
  return forEachCommittedMove(userDataPath, warn, (scope) => focusWrites(profile, scope))
}

/**
 * The unload checkpoint's correction, after it staged the window's state and before the flush:
 * focus for every committed move, and the additive rewrites for those rewritten under this window.
 */
export function reapplyWslMoveRewritesAtUnload(
  userDataPath: string,
  profile: WslMoveStaleWindowProfile,
  warn: Warn = defaultWarn
): number {
  if (!wslHostsGateOpen()) {
    return 0
  }
  // Not drained: a prepared reload's first unload is synthetic, and the window outlives it.
  const underWindow = new Set(listWslMoveRewritesUnderOpenWindow())
  return forEachCommittedMove(userDataPath, warn, (scope, migrationId, cutover) => {
    const writes = underWindow.has(migrationId) ? additiveWrites(profile, scope, cutover) : 0
    return writes + focusWrites(profile, scope)
  })
}

/**
 * The stale window's document was replaced (reload or new page): it can no longer write, and the
 * next one has not read yet. A last redo of the additive rewrites, then they are done for good.
 */
export function reapplyWslMoveRewritesAtWindowNavigation(
  userDataPath: string,
  profile: WslMoveStaleWindowProfile,
  warn: Warn = defaultWarn
): number {
  if (!wslHostsGateOpen()) {
    return 0
  }
  const underWindow = new Set(takeWslMoveRewritesUnderOpenWindow())
  if (underWindow.size === 0) {
    return 0
  }
  return forEachCommittedMove(userDataPath, warn, (scope, migrationId, cutover) =>
    underWindow.has(migrationId) ? additiveWrites(profile, scope, cutover) : 0
  )
}

/** Main-frame document commits of the app window; `did-navigate` skips in-page navigations. */
export function reapplyWslMoveRewritesWhenDocumentReplaced(
  contents: { on: (event: 'did-navigate', listener: () => void) => unknown },
  userDataPath: string,
  profile: WslMoveStaleWindowProfile
): void {
  contents.on('did-navigate', () => {
    reapplyWslMoveRewritesAtWindowNavigation(userDataPath, profile)
  })
}

function additiveWrites(
  profile: WslMoveStaleWindowProfile,
  scope: WslMoveRewriteScope,
  cutover: Parameters<typeof wslMoveDesktopRewriteContext>[1]
): number {
  let writes = 0
  const updates = rewriteWslMoveUiRouting(profile.getUI(), scope)
  if (Object.keys(updates).length > 0) {
    profile.updateUI(updates)
    writes += 1
  }
  // The window's save replaced the partition with its mirror of the host's tabs, which lacks
  // what only the seed carries (browser tabs, drafts): add those back beside it.
  if (applyWslMoveHostSessionSeed(profile, cutover, scope, new Set(), true).length > 0) {
    writes += 1
  }
  return writes
}

function focusWrites(profile: WslMoveStaleWindowProfile, scope: WslMoveRewriteScope): number {
  let writes = 0
  const lastActive = wslMoveLastActiveWorktreeUpdate(profile.getUI(), scope)
  if (lastActive) {
    profile.updateUI(lastActive)
    writes += 1
  }
  return applyWslMoveSessionFocus(profile, scope) ? writes + 1 : writes
}

function forEachCommittedMove(
  userDataPath: string,
  warn: Warn,
  apply: (
    scope: WslMoveRewriteScope,
    migrationId: string,
    cutover: Parameters<typeof wslMoveDesktopRewriteContext>[1]
  ) => number
): number {
  if (!wslHostsGateOpen()) {
    return 0
  }
  let writes = 0
  try {
    for (const cutover of scanWslMoveCutovers(userDataPath)) {
      if (WSL_MOVE_CUTOVER_PHASES.indexOf(cutover.phase) < COMMITTED_PHASE_INDEX) {
        continue
      }
      const scope = wslMoveRewriteScope(wslMoveDesktopRewriteContext(userDataPath, cutover))
      writes += apply(scope, cutover.migrationId, cutover)
    }
  } catch (error) {
    warn(`[wsl-move] Could not re-apply a finished move after a stale window: ${describe(error)}`)
  }
  return writes
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
