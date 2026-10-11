// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { TerminalLayoutController } from './terminal/layout/terminal-layout-controller'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { OrcaRuntimeWithFitOverrideListeners } from './orca-runtime-fit-override-listeners'

import { RuntimeEdgeCommandController } from './runtime-edge-command-controller'
import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import type { RuntimeCommandSurfaceHost } from './orca-runtime-core'
import { RuntimeBrowserDriverController } from './runtime-browser-driver-controller'

import type { StatsCollector } from '../stats/collector'
import { RuntimeRemoteFetchController } from './runtime-remote-fetch-controller'
import { RuntimeWorktreeBaseReconciliation } from './runtime-worktree-base-reconciliation'
import { RuntimeWorktreeRemovalInFlight } from './runtime-worktree-removal-in-flight'

export class OrcaRuntimeWithTerminalDrivers extends OrcaRuntimeWithFitOverrideListeners {
  protected readonly terminalLayout = new TerminalLayoutController({
    getStore: () => this.store,
    getNotifier: () => this.notifier,
    getPtyController: () => this.ptyController,
    getTerminalSize: (ptyId) => this.getTerminalSize(ptyId),
    resizeHeadlessTerminal: (ptyId, cols, rows) => this.resizeHeadlessTerminal(ptyId, cols, rows),
    notifyRemoteTerminalViewPresenceChanged: (ptyId) =>
      this.notifyRemoteTerminalViewPresenceChanged(ptyId),
    isUnattachedLocalCandidate: (ptyId) => {
      if (
        this.headlessTerminals.has(ptyId) ||
        this.providerSnapshotPreferredPtys.has(ptyId) ||
        this.pendingPtyRegistrationIncarnations.has(ptyId) ||
        parseAppSshPtyId(ptyId)
      ) {
        return false
      }
      const pty = this.ptysById.get(ptyId)
      return pty !== undefined && pty.connectionId === null && pty.connected
    }
  })

  protected readonly edgeCommands = new RuntimeEdgeCommandController({
    browserHost: {
      getAgentBrowserBridge: () => this.agentBrowserBridge,
      resolveWorktreeSelector: (selector) => this.resolveWorktreeSelector(selector),
      resolveBrowserWorkspace: (selector) => this.resolveBrowserWorkspace(selector),
      getBrowserHostLeaseRegistry: () => getBrowserHostLeaseRegistry(this),
      getRuntimeBrowserPageRegistry: () => getRuntimeBrowserPageRegistry(this),
      resolveBrowserNetworkExecutionHost: (worktree) =>
        this.resolveBrowserNetworkExecutionHostForWorktree(worktree),
      getAuthoritativeWindow: () => this.getAuthoritativeWindow(),
      getAvailableAuthoritativeWindow: () => this.getAvailableAuthoritativeWindow(),
      getOffscreenBrowserBackend: () => this.offscreenBrowserBackend,
      markHeadlessBrowserSessionTabActive: this.markHeadlessBrowserSessionTabActive.bind(this),
      notifyHeadlessBrowserSessionTabsChanged: (worktreeId) =>
        this.notifyMobileSessionTabsChanged(worktreeId),
      retireRuntimeOwnedBrowserSessionTab: (worktreeId, browserPageId) =>
        this.retireRuntimeOwnedBrowserSessionTab(worktreeId, browserPageId)
    },
    screencast: {
      registerSubscriptionCleanup: (subscriptionId, cleanup, connectionId) =>
        (this as RuntimeCommandSurfaceHost<this>).registerSubscriptionCleanup(
          subscriptionId,
          cleanup,
          connectionId
        ),
      cleanupSubscription: (subscriptionId) =>
        (this as RuntimeCommandSurfaceHost<this>).cleanupSubscription(subscriptionId),
      getDriver: (browserPageId) => this.browserDrivers.get(browserPageId),
      setDriver: (browserPageId, next) => this.browserDrivers.set(browserPageId, next),
      notifyRemoteViewersChanged: (browserPageId, hasRemoteViewers) =>
        this.notifier?.browserRemoteViewersChanged?.(browserPageId, hasRemoteViewers)
    },
    getBrowserCommands: () => this.browserCommands,
    emulatorHost: {
      getEmulatorBridge: () => this.emulatorBridge,
      resolveEmulatorWorkspaceId: (selector) => this.resolveEmulatorWorkspaceId(selector),
      resolveEmulatorCleanupWorkspaceId: (selector) =>
        this.resolveEmulatorCleanupWorkspaceId(selector),
      getAuthoritativeWindow: () => this.getAuthoritativeWindow(),
      getSettings: () => this.requireStore().getSettings()
    }
  })

  // Why: tests and diagnostic seams replace only screencast startup; ordinary edge methods stay pre-bound.
  protected browserCommands = this.edgeCommands.getBrowserCommands()

  protected readonly browserDrivers = new RuntimeBrowserDriverController({
    notifyChanged: (browserPageId, next) =>
      this.notifier?.browserDriverChanged?.(browserPageId, next),
    cancelScreencast: (browserPageId) => this.edgeCommands.cancelScreencast(browserPageId)
  })

  protected stats: StatsCollector | null = null

  // Why: create and drift probes must share one fetch/freshness owner.
  protected readonly remoteFetches = new RuntimeRemoteFetchController()

  protected readonly worktreeBaseReconciliation = new RuntimeWorktreeBaseReconciliation(
    this.remoteFetches,
    () => this.notifier
  )

  protected readonly removeManagedWorktreeInFlight = new RuntimeWorktreeRemovalInFlight()
}
