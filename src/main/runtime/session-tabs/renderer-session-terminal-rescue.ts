import { runtimeWorktreeIdsEqual } from '../runtime-worktree-path-identity'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import type {
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-types'

export type RuntimeRendererSessionTerminalRescueHost = {
  ownedPtyIds(): Set<string>
  ptyRecords(): ReadonlyMap<string, RuntimePtyWorktreeRecord>
  getSnapshot(worktreeId: string): RuntimeMobileSessionTabsSnapshot | undefined
  storeMobileSessionSnapshot(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot
  publishPtyBackedMobileSessionTerminal(
    worktreeId: string,
    pty: RuntimePtyWorktreeRecord,
    options: {
      tabId: string
      leafId: string
      title: null
      activate: false
      selectIfNoActiveTab: false
      notify?: boolean
    }
  ): unknown
}

export class RuntimeRendererSessionTerminalRescue {
  constructor(private readonly host: RuntimeRendererSessionTerminalRescueHost) {}

  restoreLivePairedRendererSessionOwnedMobileTerminals(
    worktreeId: string | null,
    options: { missingSnapshotOnly?: boolean; notify?: boolean } = {}
  ): void {
    for (const ptyId of this.host.ownedPtyIds()) {
      const pty = this.host.ptyRecords().get(ptyId)
      if (
        !pty?.connected ||
        !pty.tabId ||
        (worktreeId !== null && !runtimeWorktreeIdsEqual(pty.worktreeId, worktreeId))
      ) {
        continue
      }
      const targetWorktreeId = worktreeId ?? pty.worktreeId
      const pane = parsePaneKey(pty.paneKey ?? '')
      if (!pane || pane.tabId !== pty.tabId) {
        continue
      }
      const existing = this.host.getSnapshot(targetWorktreeId)
      if (existing && options.missingSnapshotOnly) {
        continue
      }
      if (
        existing?.tabs.some(
          (tab) =>
            tab.type === 'terminal' &&
            (tab.ptyId === pty.ptyId ||
              (tab.parentTabId === pty.tabId && tab.leafId === pane.leafId))
        )
      ) {
        continue
      }
      if (!existing) {
        this.host.storeMobileSessionSnapshot(targetWorktreeId, {
          worktree: targetWorktreeId,
          publicationEpoch: `renderer-rescue:${Date.now().toString(36)}`,
          snapshotVersion: 0,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabGroups: [],
          tabs: []
        })
      }
      this.host.publishPtyBackedMobileSessionTerminal(targetWorktreeId, pty, {
        tabId: pty.tabId,
        leafId: pane.leafId,
        title: null,
        activate: false,
        selectIfNoActiveTab: false,
        notify: options.notify
      })
    }
  }

  setPairedRendererSessionOwnership(ptyId: string, owned: boolean): void {
    if (owned) {
      this.host.ownedPtyIds().add(ptyId)
    } else {
      this.host.ownedPtyIds().delete(ptyId)
    }
  }

  findLiveRegisteredPtyForRendererTab(
    worktreeId: string,
    tabId: string
  ): RuntimePtyWorktreeRecord | null {
    for (const pty of this.host.ptyRecords().values()) {
      if (
        pty.worktreeId === worktreeId &&
        pty.tabId === tabId &&
        pty.connected &&
        parsePaneKey(pty.paneKey ?? '')?.leafId
      ) {
        return pty
      }
    }
    return null
  }

  hasLiveShellForRendererTab(worktreeId: string, tabId: string): boolean {
    for (const pty of this.host.ptyRecords().values()) {
      if (pty.worktreeId === worktreeId && pty.tabId === tabId && pty.connected) {
        return true
      }
    }
    return false
  }

  isReadyMobileTerminalSurface(surface: RuntimeMobileSessionCreateTerminalResult | null): boolean {
    return (
      surface?.tab.status === 'ready' &&
      typeof surface.tab.terminal === 'string' &&
      surface.tab.terminal.length > 0
    )
  }
}
