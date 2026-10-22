/**
 * A window hydrated before a move's rewrite can still write the old focus (the session's active
 * workspace, the UI's last-active worktree) for a moved project, and its unload checkpoint does.
 * So at startup and after every unload checkpoint the corrective part of `ui-routing` and
 * `session-globals` runs again for each committed move. Nothing else is re-applied: the additive
 * rewrites (host copies, visible hosts, the automation filter) would undo a later user choice.
 * No ledger entry is written; the ledgered pass alone owns the journal.
 */
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { WSL_MOVE_CUTOVER_PHASES } from '../../../shared/wsl-move/wsl-move-cutover'
import { wslHostsGateOpen } from '../../wsl/wsl-host-gate'
import type { Store } from '../loading-store/store'
import { listWslMoveCutovers } from './wsl-move-cutover-journal'
import { applyWslMoveSessionFocus } from './wsl-move-main-rewrite-stores'
import { createUncToLinuxPathRewriter } from './wsl-move-path-rewriter'
import { wslMoveRewriteScope } from './wsl-move-rewrite-scope'
import { wslMoveLastActiveWorktreeUpdate } from './wsl-move-ui-routing-rewrite'

export type WslMoveFocusProfile = Pick<
  Store,
  'getUI' | 'updateUI' | 'getWorkspaceSession' | 'patchWorkspaceSession'
>

const COMMITTED_PHASE_INDEX = WSL_MOVE_CUTOVER_PHASES.indexOf('destination-committed')

/** Never throws; a no-op with the gate closed or no committed move. Returns how many writes it made. */
export function reapplyWslMoveFocusRewrites(
  userDataPath: string,
  profile: WslMoveFocusProfile,
  warn: (message: string) => void = (message) => console.warn(message)
): number {
  if (!wslHostsGateOpen()) {
    return 0
  }
  let writes = 0
  try {
    for (const cutover of listWslMoveCutovers(userDataPath)) {
      if (WSL_MOVE_CUTOVER_PHASES.indexOf(cutover.phase) < COMMITTED_PHASE_INDEX) {
        continue
      }
      const scope = wslMoveRewriteScope({
        cutover,
        rewritePath: createUncToLinuxPathRewriter(cutover.manifest.source.distro),
        destinationHostId: toRuntimeExecutionHostId(cutover.destinationEnvironmentId),
        // Seeding is the ledgered pass's alone; the scope never records.
        recordSeededHostWorkspaceIds: () => {
          throw new Error('wsl_move_focus_reapply_seeds_nothing')
        }
      })
      const lastActive = wslMoveLastActiveWorktreeUpdate(profile.getUI(), scope)
      if (lastActive) {
        profile.updateUI(lastActive)
        writes += 1
      }
      if (applyWslMoveSessionFocus(profile, scope)) {
        writes += 1
      }
    }
  } catch (error) {
    warn(`[wsl-move] Could not re-apply a moved project's focus: ${describe(error)}`)
  }
  return writes
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
