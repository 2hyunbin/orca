import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import type { RuntimeGraphState } from './session-graph-state'
import type { RuntimeStore } from '../runtime-store-contract'
import type { RuntimeSessionGraphLifecycle } from './session-graph-lifecycle'

export type RuntimeSessionGraphPromotionHost = {
  state: RuntimeGraphState
  getStore(): Pick<RuntimeStore, 'getWorkspaceSession' | 'setWorkspaceSession'> | null
  ptys(): Iterable<RuntimePtyWorktreeRecord>
  getWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId
  persistWindowlessPtyBindingsForDesktopAttach: RuntimeSessionGraphPromotion['persistWindowlessPtyBindingsForDesktopAttach']
  beginGraphReload: RuntimeSessionGraphLifecycle['beginGraphReload']
}

export class RuntimeSessionGraphPromotion {
  private get store(): ReturnType<RuntimeSessionGraphPromotionHost['getStore']> {
    return this.host.getStore()
  }

  constructor(private readonly host: RuntimeSessionGraphPromotionHost) {}

  attachWindow(windowId: number): void {
    if (this.host.state.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID) {
      if (
        this.host.state.pendingHeadlessPromotionWindowId !== null &&
        windowId !== this.host.state.pendingHeadlessPromotionWindowId
      ) {
        return
      }
      // Why: promotion is a renderer reload of the same graph owner, not a new
      // runtime; stale handles must transition before the real window publishes.
      this.host.persistWindowlessPtyBindingsForDesktopAttach()
      this.host.state.pendingHeadlessPromotionWindowId = windowId
      this.host.state.authoritativeWindowId = windowId
      this.host.beginGraphReload(windowId)
      return
    }
    if (this.host.state.authoritativeWindowId === null) {
      // Why: a promoted serve can close and later reopen its window while new
      // background PTYs keep arriving; every windowless gap needs this handoff.
      this.host.persistWindowlessPtyBindingsForDesktopAttach()
      this.host.state.authoritativeWindowId = windowId
    }
  }

  persistWindowlessPtyBindingsForDesktopAttach(): void {
    if (!this.store?.getWorkspaceSession || !this.store.setWorkspaceSession) {
      return
    }
    const partitions = new Map<
      ExecutionHostId,
      { session: WorkspaceSessionState; ptys: RuntimePtyWorktreeRecord[] }
    >()
    for (const pty of this.host.ptys()) {
      if (!pty.connected || !pty.tabId) {
        continue
      }
      const hostId = this.host.getWorkspaceSessionHostIdForWorktree(pty.worktreeId)
      const session = this.store.getWorkspaceSession(hostId)
      const tab = session.tabsByWorktree[pty.worktreeId]?.find(
        (candidate) => candidate.id === pty.tabId
      )
      if (!tab) {
        continue
      }
      const layoutPtyIds = Object.values(
        session.terminalLayoutsByTabId[pty.tabId]?.ptyIdsByLeafId ?? {}
      )
      if (tab.ptyId !== pty.ptyId && !layoutPtyIds.includes(pty.ptyId)) {
        continue
      }
      const partition = partitions.get(hostId) ?? { session, ptys: [] }
      partition.ptys.push(pty)
      partitions.set(hostId, partition)
    }

    for (const [hostId, { session, ptys }] of partitions) {
      // Why: windowless SSH PTYs must be handed to the desktop through their SSH partition, never the local session.
      const activeWorktreeIdsOnShutdown = [
        ...new Set([
          ...(session.activeWorktreeIdsOnShutdown ?? []),
          ...ptys.map((pty) => pty.worktreeId)
        ])
      ]
      const activeConnectionIdsAtShutdown = [
        ...new Set([
          ...(session.activeConnectionIdsAtShutdown ?? []),
          ...ptys
            .map((pty) => pty.connectionId)
            .filter((connectionId): connectionId is string => connectionId !== null)
        ])
      ]
      const remoteSessionIdsByTabId = { ...session.remoteSessionIdsByTabId }
      for (const pty of ptys) {
        if (pty.connectionId && pty.tabId) {
          remoteSessionIdsByTabId[pty.tabId] = pty.ptyId
        }
      }

      this.store.setWorkspaceSession(
        {
          ...session,
          activeWorktreeIdsOnShutdown,
          ...(activeConnectionIdsAtShutdown.length > 0 ? { activeConnectionIdsAtShutdown } : {}),
          ...(Object.keys(remoteSessionIdsByTabId).length > 0 ? { remoteSessionIdsByTabId } : {})
        },
        hostId
      )
    }
  }
}
