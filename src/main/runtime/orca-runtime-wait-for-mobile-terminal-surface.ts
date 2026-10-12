/* eslint-disable unicorn/no-useless-spread */
// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCreateRuntimeOwnedMobileSessionTerminal } from './orca-runtime-create-runtime-owned-mobile-session-terminal'
import type {
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTerminalClientTab
} from '../../shared/runtime-types'
import { MOBILE_TERMINAL_SURFACE_TIMEOUT_MS } from './orca-runtime-core'
import { makePaneKey } from '../../shared/stable-pane-id'
import { resolveTerminalSessionWorktreeId } from './runtime-worktree-path-identity'
import { worktreeIdsEqual } from '../../shared/worktree/id'
import type {
  RuntimePtyTabCloseAuthority,
  RuntimePtyWorktreeRecord
} from './runtime-terminal-state-records'

export class OrcaRuntimeWithWaitForMobileTerminalSurface extends OrcaRuntimeWithCreateRuntimeOwnedMobileSessionTerminal {
  protected waitForMobileTerminalSurface(
    worktreeId: string,
    parentTabId: string,
    options: { timeoutMs?: number; requireReady?: boolean; signal?: AbortSignal } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    const timeoutMs = options.timeoutMs ?? MOBILE_TERMINAL_SURFACE_TIMEOUT_MS
    const existing = this.findMobileTerminalSurface(worktreeId, parentTabId, options)
    if (existing) {
      return Promise.resolve(existing)
    }
    if (options.signal?.aborted) {
      return Promise.reject(new Error('client_disconnected'))
    }

    return new Promise<RuntimeMobileSessionCreateTerminalResult>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        const idx = this.graphSyncCallbacks.indexOf(check)
        if (idx !== -1) {
          this.graphSyncCallbacks.splice(idx, 1)
        }
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Timed out waiting for terminal surface after creation'))
      }, timeoutMs)
      // Why: a dead client connection cancels the wait immediately instead of running down the timeout into rollback (#7718).
      const onAbort = (): void => {
        cleanup()
        reject(new Error('client_disconnected'))
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      const check = (): void => {
        const next = this.findMobileTerminalSurface(worktreeId, parentTabId, options)
        if (!next) {
          return
        }
        cleanup()
        resolve(next)
      }
      this.graphSyncCallbacks.push(check)
      check()
    })
  }

  protected findMobileTerminalSurface(
    worktreeId: string,
    parentTabId: string,
    options: { requireReady?: boolean } = {}
  ): RuntimeMobileSessionCreateTerminalResult | null {
    const snapshot = this.readSessionTabsSnapshot(worktreeId)
    if (!snapshot) {
      return null
    }
    const result = this.toMobileSessionTabsResult(snapshot)
    const tab = result.tabs.find(
      (candidate) => candidate.type === 'terminal' && candidate.parentTabId === parentTabId
    )
    if (!tab || tab.type !== 'terminal') {
      return null
    }
    const surface = {
      tab,
      publicationEpoch: result.publicationEpoch,
      snapshotVersion: result.snapshotVersion
    }
    if (options.requireReady === true && !this.isReadyMobileTerminalSurface(surface)) {
      return null
    }
    return surface
  }

  protected findMobileTerminalSurfaceForPty(
    worktreeId: string,
    ptyId: string
  ): RuntimeMobileSessionCreateTerminalResult | null {
    const snapshot = this.readSessionTabsSnapshot(worktreeId)
    if (!snapshot) {
      return null
    }
    const result = this.toMobileSessionTabsResult(snapshot)
    const tabs = result.tabs.filter(
      (candidate): candidate is RuntimeMobileSessionTerminalClientTab =>
        candidate.type === 'terminal' &&
        (candidate.ptyId === ptyId ||
          candidate.parentLayout?.ptyIdsByLeafId?.[candidate.leafId] === ptyId)
    )
    if (tabs.length === 0 || new Set(tabs.map((tab) => tab.parentTabId)).size !== 1) {
      return null
    }
    return {
      tab: tabs[0]!,
      publicationEpoch: result.publicationEpoch,
      snapshotVersion: result.snapshotVersion
    }
  }

  protected resolvePtyTabCloseSurfaceAuthority(
    authority: RuntimePtyTabCloseAuthority
  ): { pty: RuntimePtyWorktreeRecord; surface: RuntimeMobileSessionCreateTerminalResult } | null {
    const live = this.getLivePtyForHandle(authority.handle)
    if (
      !live ||
      live.pty.ptyId !== authority.ptyId ||
      live.pty.worktreeId !== authority.worktreeId ||
      live.record.worktreeId !== authority.worktreeId ||
      live.pty.incarnationId !== authority.incarnationId
    ) {
      return null
    }
    const surface = this.findMobileTerminalSurfaceForPty(authority.worktreeId, authority.ptyId)
    if (!surface) {
      return null
    }
    const [hostId] = this.getWorkspaceSessionHostIdsForTab(
      authority.worktreeId,
      surface.tab.parentTabId
    )
    const session = hostId ? (this.store?.getWorkspaceSession?.(hostId) ?? null) : null
    const sessionWorktreeId = session
      ? resolveTerminalSessionWorktreeId(session, authority.worktreeId)
      : null
    const persistedTab = sessionWorktreeId
      ? session?.tabsByWorktree[sessionWorktreeId]?.find(
          (tab) => tab.id === surface.tab.parentTabId
        )
      : undefined
    if (persistedTab && !worktreeIdsEqual(persistedTab.worktreeId, authority.worktreeId)) {
      return null
    }
    const paneKey = makePaneKey(surface.tab.parentTabId, surface.tab.leafId)
    const persistedPtyId =
      session?.terminalLayoutsByTabId?.[surface.tab.parentTabId]?.ptyIdsByLeafId?.[
        surface.tab.leafId
      ] ?? null
    const persistedIncarnationId = session?.terminalPtyIncarnationsByPaneKey?.[paneKey] ?? null
    if (
      (persistedPtyId && persistedPtyId !== authority.ptyId) ||
      (persistedIncarnationId && persistedIncarnationId !== authority.incarnationId)
    ) {
      return null
    }
    if (
      !this.resolveTerminalSplitSourceAuthority(
        authority.worktreeId,
        surface.tab.parentTabId,
        surface.tab.leafId,
        authority.ptyId
      )
    ) {
      return null
    }
    return { pty: live.pty, surface }
  }

  // Why: an in-flight mobile create's live PTY is owned by this session as soon as it registers (#7587).
  protected ensurePtyBackedMobileSurfaceForRendererTab(
    worktreeId: string,
    tabId: string
  ): RuntimeMobileSessionCreateTerminalResult | null {
    const pending = this.pendingMobileTerminalCreatesByKey.get(`${worktreeId}::${tabId}`)
    if (!pending) {
      return null
    }
    const pty = this.findLiveRegisteredPtyForRendererTab(worktreeId, tabId)
    if (pty) {
      pty.runtimeSessionOwned = true
      if (pending.paired) {
        this.setPairedRendererSessionOwnership(pty.ptyId, true)
      }
    }
    return this.findMobileTerminalSurface(worktreeId, tabId)
  }
}
