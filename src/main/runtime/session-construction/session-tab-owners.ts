import { RuntimeSessionTabsInventory } from '../session-tabs/session-tabs-inventory'
import { RuntimeTerminalSurfaceRetirements } from '../session-tabs/terminal-surface-retirements'
import { RuntimeStructuredSessionTabs } from '../session-tabs/structured-session-tabs'
import { RuntimeMobileSessionPreservation } from '../session-tabs/mobile-session-preservation'
import { RuntimeMobileSessionHydration } from '../session-tabs/mobile-session-hydration'
import type { SessionLifecyclePorts } from './session-lifecycle-ports'

export function createRuntimeSessionTabsInventory(ports: () => SessionLifecyclePorts) {
  return new RuntimeSessionTabsInventory({
    get getValidatedExplicitWorktreeIdSelector() {
      return ports().bindRuntimeMethod(ports().getValidatedExplicitWorktreeIdSelector())
    },
    get resolveWorktreeSelector() {
      return ports().bindRuntimeMethod(ports().resolveWorktreeSelector())
    },
    get hydrateHeadlessMobileSessionTabsFromWorkspaceSession() {
      return ports().bindRuntimeMethod(
        ports().hydrateHeadlessMobileSessionTabsFromWorkspaceSession()
      )
    },
    get refreshMobileSessionPtyRecords() {
      return ports().bindRuntimeMethod(ports().refreshMobileSessionPtyRecords())
    },
    get refreshMobileSessionPtyInventory() {
      return ports().bindRuntimeMethod(ports().refreshMobileSessionPtyInventory())
    },
    get restoreLivePairedRendererSessionOwnedMobileTerminals() {
      return ports().bindRuntimeMethod(
        ports().restoreLivePairedRendererSessionOwnedMobileTerminals()
      )
    },
    get getMobileSessionTabsForWorktree() {
      return ports().bindRuntimeMethod(ports().getMobileSessionTabsForWorktree())
    },
    get getKnownWorkspaceSessionWorktreeIds() {
      return ports().bindRuntimeMethod(ports().getKnownWorkspaceSessionWorktreeIds())
    },
    get getMobileSnapshots() {
      return ports().getSnapshotValues
    },
    get projectMobileSessionTabsForClient() {
      return ports().bindRuntimeMethod(ports().projectMobileSessionTabsForClient())
    },
    get toMobileSessionTabsResult() {
      return ports().bindRuntimeMethod(ports().toMobileSessionTabsResult())
    },
    get getChangeSequence() {
      return ports().getChangeSequence
    },
    get listKnownExecutionHostIds() {
      return ports().bindRuntimeMethod(ports().listKnownExecutionHostIds())
    },
    get publication() {
      return ports().publication
    },
    get listAllMobileSessionTabsWithChangeSequence() {
      return ports().bindRuntimeMethod(ports().listAllMobileSessionTabsWithChangeSequence())
    },
    get collectAllMobileSessionTabs() {
      return ports().bindRuntimeMethod(ports().collectAllMobileSessionTabs())
    },
    get listAllMobileSessionTabsInventoryWithChangeSequence() {
      return ports().bindRuntimeMethod(
        ports().listAllMobileSessionTabsInventoryWithChangeSequence()
      )
    },
    get assertSessionTabsInventoryRequestActive() {
      return ports().bindRuntimeMethod(ports().assertSessionTabsInventoryRequestActive())
    },
    get getAuthoritativeSessionTabsInventoryEpoch() {
      return ports().bindRuntimeMethod(ports().getAuthoritativeSessionTabsInventoryEpoch())
    },
    get settleSessionTabsInventory() {
      return ports().bindRuntimeMethod(ports().settleSessionTabsInventory())
    },
    get waitForSessionTabsInventoryPublication() {
      return ports().bindRuntimeMethod(ports().waitForSessionTabsInventoryPublication())
    },
    get isCompleteSessionTabsPtyCensus() {
      return ports().bindRuntimeMethod(ports().isCompleteSessionTabsPtyCensus())
    }
  })
}

export function createRuntimeTerminalSurfaceRetirements(ports: () => SessionLifecyclePorts) {
  return new RuntimeTerminalSurfaceRetirements({
    get getStore() {
      return ports().getStore
    },
    get tryGetWorkspaceSessionHostIdForWorktree() {
      return ports().bindRuntimeMethod(ports().tryGetWorkspaceSessionHostIdForWorktree())
    },
    get getPtyHandle() {
      return ports().getPtyHandle
    },
    get findHandleForPtyRecord() {
      return ports().bindRuntimeMethod(ports().findHandleForPtyRecord())
    },
    get getMobileSnapshots() {
      return ports().getSnapshots
    },
    get getTopologyRevisions() {
      return ports().getTopologyRevisions
    },
    get storeMobileSessionSnapshot() {
      return ports().bindRuntimeMethod(ports().storeMobileSessionSnapshot())
    },
    get notifyMobileSessionTabsChanged() {
      return ports().bindRuntimeMethod(ports().notifyMobileSessionTabsChanged())
    },
    get stageTerminalSurfaceRetirements() {
      return ports().bindRuntimeMethod(ports().stageTerminalSurfaceRetirements())
    },
    get publishRetiredTerminalSurfaceProofs() {
      return ports().bindRuntimeMethod(ports().publishRetiredTerminalSurfaceProofs())
    },
    get persistStagedTerminalSurfaceRetirements() {
      return ports().bindRuntimeMethod(ports().persistStagedTerminalSurfaceRetirements())
    }
  })
}

export function createRuntimeStructuredSessionTabs(ports: () => SessionLifecyclePorts) {
  return new RuntimeStructuredSessionTabs({
    get prepareStructuredAgentSessionStartupRestoration() {
      return ports().bindRuntimeMethod(ports().prepareStructuredAgentSessionStartupRestoration())
    },
    get getStore() {
      return ports().getStore
    },
    get getKnownWorkspaceSessionWorktreeIds() {
      return ports().bindRuntimeMethod(ports().getKnownWorkspaceSessionWorktreeIds())
    },
    get hydrateHeadlessMobileSessionTabsFromWorkspaceSession() {
      return ports().bindRuntimeMethod(
        ports().hydrateHeadlessMobileSessionTabsFromWorkspaceSession()
      )
    },
    get hasPersistedStructuredAgentSessionStore() {
      return ports().bindRuntimeMethod(ports().hasPersistedStructuredAgentSessionStore())
    },
    get notifyMobileSessionTabSnapshots() {
      return ports().bindRuntimeMethod(ports().notifyMobileSessionTabSnapshots())
    },
    get getMobileSnapshots() {
      return ports().getSnapshots
    },
    get storeMobileSessionSnapshot() {
      return ports().bindRuntimeMethod(ports().storeMobileSessionSnapshot())
    },
    get emitMobileSessionTabsSnapshot() {
      return ports().bindRuntimeMethod(ports().emitMobileSessionTabsSnapshot())
    },
    get projectStructuredAgentSessionTab() {
      return ports().bindRuntimeMethod(ports().projectStructuredAgentSessionTab())
    },
    get retireStructuredAgentSessionTabFromSnapshot() {
      return ports().bindRuntimeMethod(ports().retireStructuredAgentSessionTabFromSnapshot())
    },
    get restoreStructuredAgentSessionTabsOnce() {
      return ports().bindRuntimeMethod(ports().restoreStructuredAgentSessionTabsOnce())
    }
  })
}

export function createRuntimeMobileSessionPreservation(ports: () => SessionLifecyclePorts) {
  return new RuntimeMobileSessionPreservation({
    get getWorkspaceSessionForWorktree() {
      return ports().bindRuntimeMethod(ports().getWorkspaceSessionForWorktree())
    },
    get isMobileTerminalCreatePending() {
      return ports().isMobileTerminalCreatePending
    },
    get hasLiveRuntimeSessionOwnedPtyBinding() {
      return ports().bindRuntimeMethod(ports().hasLiveRuntimeSessionOwnedPtyBinding())
    },
    get hasLiveOrPersistedServeOrSshOwnedPtyBinding() {
      return ports().bindRuntimeMethod(ports().hasLiveOrPersistedServeOrSshOwnedPtyBinding())
    },
    get clearRuntimeSessionOwnershipForMobileTab() {
      return ports().bindRuntimeMethod(ports().clearRuntimeSessionOwnershipForMobileTab())
    },
    get getPty() {
      return ports().getPty
    },
    get setPairedRendererSessionOwnership() {
      return ports().bindRuntimeMethod(ports().setPairedRendererSessionOwnership())
    },
    get getClientBrowserPage() {
      return ports().getClientBrowserPage
    },
    get hasOffscreenBrowserBackend() {
      return ports().hasOffscreenBrowserBackend
    },
    get getLiveBrowserTabsByPageId() {
      return ports().bindRuntimeMethod(ports().getLiveBrowserTabsByPageId())
    },
    get collectPreservedHeadlessMobileSessionTabs() {
      return ports().bindRuntimeMethod(ports().collectPreservedHeadlessMobileSessionTabs())
    },
    get getMergedMobileSessionPublicationEpoch() {
      return ports().bindRuntimeMethod(ports().getMergedMobileSessionPublicationEpoch())
    },
    get mergeStructuredAgentSessionTabGroups() {
      return ports().bindRuntimeMethod(ports().mergeStructuredAgentSessionTabGroups())
    },
    get isHeadlessBuiltMobileSessionPublicationBase() {
      return ports().bindRuntimeMethod(ports().isHeadlessBuiltMobileSessionPublicationBase())
    },
    get shouldPreserveHeadlessMobileSessionTab() {
      return ports().bindRuntimeMethod(ports().shouldPreserveHeadlessMobileSessionTab())
    }
  })
}

export function createRuntimeMobileSessionHydration(ports: () => SessionLifecyclePorts) {
  return new RuntimeMobileSessionHydration({
    get hasAuthoritativeWindow() {
      return ports().hasAuthoritativeWindow
    },
    get getWorkspaceSessionForWorktree() {
      return ports().bindRuntimeMethod(ports().getWorkspaceSessionForWorktree())
    },
    get getStore() {
      return ports().getStore
    },
    get hasOffscreenBrowserBackend() {
      return ports().hasOffscreenBrowserBackend
    },
    get countClientBrowserPages() {
      return ports().countClientBrowserPages
    },
    get workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate() {
      return ports().bindRuntimeMethod(
        ports().workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate()
      )
    },
    get workspaceSessionHasRuntimeOwnedPtyCandidate() {
      return ports().bindRuntimeMethod(ports().workspaceSessionHasRuntimeOwnedPtyCandidate())
    },
    get getSnapshot() {
      return ports().getSnapshot
    },
    get reconcileHeadlessMobileSessionBrowserTabs() {
      return ports().bindRuntimeMethod(ports().reconcileHeadlessMobileSessionBrowserTabs())
    },
    get hasServeOrSshOwnedBinding() {
      return ports().bindRuntimeMethod(ports().hasServeOrSshOwnedBinding())
    },
    get hasRecentExpiredSshLeasePane() {
      return ports().bindRuntimeMethod(ports().hasRecentExpiredSshLeasePane())
    },
    get buildHeadlessMobileSessionBrowserTabs() {
      return ports().bindRuntimeMethod(ports().buildHeadlessMobileSessionBrowserTabs())
    },
    get isHeadlessBuiltMobileSessionPublicationBase() {
      return ports().bindRuntimeMethod(ports().isHeadlessBuiltMobileSessionPublicationBase())
    },
    get getMergedMobileSessionPublicationEpoch() {
      return ports().bindRuntimeMethod(ports().getMergedMobileSessionPublicationEpoch())
    },
    get storeMobileSessionSnapshot() {
      return ports().bindRuntimeMethod(ports().storeMobileSessionSnapshot())
    }
  })
}
