import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { indexFloatingSnapshotPtyBindings } from '../../floating-snapshot-pty-bindings'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../../shared/runtime-types'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'

export type RuntimeFloatingSessionLivenessHost = {
  getPtyController(): Pick<RuntimePtyController, 'hasPty'> | null
  getSnapshot(worktreeId: string): RuntimeMobileSessionTabsSnapshot | undefined
  getMobileTerminalPaneKey(tab: RuntimeMobileSessionTerminalTab): string
  ptys(): ReadonlyMap<string, RuntimePtyWorktreeRecord>
  leaves(): Iterable<RuntimeLeafRecord>
  recordPtyWorktree(
    ptyId: string,
    worktreeId: string,
    state: Partial<Pick<RuntimePtyWorktreeRecord, 'connected' | 'tabId' | 'paneKey'>>
  ): RuntimePtyWorktreeRecord
  markPtyLivenessLive(ptyId: string): void
  refreshPtyForegroundAgent(ptyId: string): void
  leafExistsForPty(ptyId: string): boolean
  pruneDisconnectedPtyRecords(): void
}

export class RuntimeFloatingSessionLiveness {
  constructor(private readonly host: RuntimeFloatingSessionLivenessHost) {}

  refreshFloatingWorkspacePtyLiveness(): Set<string> | null {
    const controller = this.host.getPtyController()
    if (!controller?.hasPty) {
      return null
    }
    const persistedBindingByPtyId = indexFloatingSnapshotPtyBindings(
      this.host.getSnapshot(FLOATING_TERMINAL_WORKTREE_ID),
      (tab) => this.host.getMobileTerminalPaneKey(tab)
    )
    const knownPtyIds = new Set<string>(persistedBindingByPtyId.keys())
    for (const pty of this.host.ptys().values()) {
      if (pty.worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
        knownPtyIds.add(pty.ptyId)
      }
    }
    for (const leaf of this.host.leaves()) {
      if (leaf.worktreeId === FLOATING_TERMINAL_WORKTREE_ID && leaf.ptyId) {
        knownPtyIds.add(leaf.ptyId)
      }
    }

    const liveness = new Map<string, boolean>()
    try {
      for (const ptyId of knownPtyIds) {
        const live = controller.hasPty(ptyId)
        if (live === null) {
          return null
        }
        liveness.set(ptyId, live)
      }
    } catch {
      return null
    }

    const livePtyIds = new Set<string>()
    for (const [ptyId, live] of liveness) {
      let pty = this.host.ptys().get(ptyId)
      if (live) {
        livePtyIds.add(ptyId)
        const binding = persistedBindingByPtyId.get(ptyId)
        if (!pty && binding) {
          // Why: a live daemon PTY restored from disk needs its pane identity before mobile can issue a safe handle.
          pty = this.host.recordPtyWorktree(ptyId, FLOATING_TERMINAL_WORKTREE_ID, {
            connected: true,
            tabId: binding.tabId,
            paneKey: binding.paneKey
          })
        }
        if (pty) {
          pty.connected = true
          pty.disconnectedAt = null
          this.host.markPtyLivenessLive(ptyId)
          this.host.refreshPtyForegroundAgent(ptyId)
        }
      } else if (pty && !this.host.leafExistsForPty(ptyId)) {
        pty.connected = false
        pty.disconnectedAt ??= Date.now()
      }
    }
    this.host.pruneDisconnectedPtyRecords()
    return livePtyIds
  }
}
