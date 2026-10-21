// Layout-owner builds: a phone's close of a terminal row in a workspace main owns is main's own
// layout close, window or not, as the CLI's close by handle is.
import { OrcaRuntimeWithRefuseUnattributedMobileSessionTabClose } from './refuse-unattributed-mobile-session-tab-close'
import type {
  RuntimeMobileSessionTerminalTab,
  RuntimeSessionTabCloseReason
} from '../../../../shared/runtime-types'
import { startedMainTerminalSurfaces } from '../../terminal/surface/main-terminal-surfaces'
import {
  closeInMainLayout,
  type MainLayoutClose
} from '../../session-tabs/main-layout-close-command'
import type { ExplicitCloseStop } from '../../session-tabs/explicit-terminal-close-pty-stops'

export abstract class OrcaRuntimeWithCloseMobileRowInMainLayout extends OrcaRuntimeWithRefuseUnattributedMobileSessionTabClose {
  protected abstract stopExplicitlyClosedTabPtys(
    ptyIds: readonly string[],
    addressedPtyId: string
  ): Promise<ExplicitCloseStop>

  /**
   * Closes the row's pane (wire id `parent::leaf`) or its tab (`parent`) in main's layout. Null for
   * a workspace main does not own and for a row its layout does not hold: today's path closes those.
   */
  protected async closeMobileRowInMainLayout(
    worktreeId: string,
    tabId: string,
    row: RuntimeMobileSessionTerminalTab,
    options: {
      force?: boolean
      reason?: RuntimeSessionTabCloseReason
      localPtyTeardownOwnedExternally?: boolean
    }
  ): Promise<MainLayoutClose | null> {
    const surfaces = startedMainTerminalSurfaces(this)
    if (!surfaces?.ownsWorkspace(worktreeId)) {
      return null
    }
    return closeInMainLayout(
      {
        panesOfTab: (id) => surfaces.panesOfTab(id),
        applyLayoutCommand: (command) => this.applyLayoutCommand(command),
        stop: (ptyIds, addressed) => this.stopExplicitlyClosedTabPtys(ptyIds, addressed),
        remoteSessionIdOf: (id) =>
          this.getWorkspaceSessionForWorktree(worktreeId)?.remoteSessionIdsByTabId?.[id]
      },
      {
        worktreeId,
        tabId: row.parentTabId,
        leafId: row.leafId,
        wholeTab: row.id !== tabId,
        force: options.force,
        // A lifecycle echo ("terminal gone") is no authority to stop a terminal, as today.
        stopEnded:
          options.localPtyTeardownOwnedExternally !== true &&
          (options.reason === undefined || options.reason === 'user')
      }
    )
  }
}
