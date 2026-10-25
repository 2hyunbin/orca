/**
 * The WSL mover's part of main-process startup: registers the desktop rewrite stores, resets or
 * finishes interrupted moves, then keeps retained rows marked and retries a failed host step.
 */
import { BrowserWindow } from 'electron'
import type { Store } from '../loading-store/store'
import { recoverInterruptedWslMoves } from './wsl-move-reset'
import { isWslDistroRegistered } from '../../wsl/wsl-distro-registry-id'
import { runWslMoveStartupRewrite } from './wsl-move-startup-rewrite'
import { installWslMoveRetention } from './wsl-move-retention'
import { registerWslMoveDesktopRewriteRegistry } from './wsl-move-desktop-rewrite-registry'
import { reapplyWslMoveFocusRewrites } from './wsl-move-stale-window-reapply'
import { sweepOrphanedWslMoveSleptSpools } from './wsl-move-slept-spool-sweep'
import { enableWslHostAutomations } from '../../ipc/wsl-host-automation-enable'
import { scheduleWslMoveRewriteRetry } from './wsl-move-rewrite-retry'
import { orchestrationDbFile } from '../../runtime/orchestration/db/orchestration-db-file'
import { productionWslMoveBrowserCookieCopyDependencies } from './wsl-move-browser-cookie-store'

/** Resolves once interrupted moves are reset or finished; main-process-ready waits on it, bounded. */
export function startWslMoveStartup(userDataPath: string, store: Store): Promise<void> {
  registerWslMoveDesktopRewriteRegistry({
    profile: store,
    windowOpen: () => BrowserWindow.getAllWindows().some((window) => !window.isDestroyed()),
    orchestrationDatabasePath: orchestrationDbFile(userDataPath),
    hostAutomations: {
      enable: (environmentId, ids) => enableWslHostAutomations(userDataPath, environmentId, ids)
    },
    browserCookies: productionWslMoveBrowserCookieCopyDependencies(userDataPath)
  })
  // Resets a move interrupted before commit, corrects stale focus on finished ones, then finishes
  // one that committed. Gated off, none runs.
  const ready = runWslMoveStartupRewrite(
    { userDataPath },
    {
      recover: async () => {
        await recoverInterruptedWslMoves(userDataPath, undefined, (distro, distroGuid) =>
          isWslDistroRegistered(distro, distroGuid)
        )
        sweepOrphanedWslMoveSleptSpools(userDataPath)
      },
      reapply: () => {
        reapplyWslMoveFocusRewrites(userDataPath, store)
      }
    }
  )
  // Re-marks retained rows a downgrade stripped; never awaited, since nothing it writes gates a read.
  void ready.then(() => {
    installWslMoveRetention({ userDataPath, store })
    // A committed move's host step (automations back on) that failed retries until it lands.
    scheduleWslMoveRewriteRetry(userDataPath)
  })
  return ready
}
