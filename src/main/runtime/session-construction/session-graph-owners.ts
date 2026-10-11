import { RuntimeMobileSessionReconciliation } from '../session-tabs/mobile-session-reconciliation'
import { RuntimeRendererSessionTerminalRescue } from '../session-tabs/renderer-session-terminal-rescue'
import { RuntimeSessionGraphLifecycle } from '../session-graph/session-graph-lifecycle'
import { RuntimeSessionWindowGraph } from '../session-graph/session-window-graph'
import type { SessionLifecyclePorts } from './session-lifecycle-ports'

export function createRuntimeMobileSessionReconciliation(ports: () => SessionLifecyclePorts) {
  return new RuntimeMobileSessionReconciliation({
    get snapshots() {
      return ports().getSnapshots
    },
    get acceptedRendererSnapshots() {
      return ports().acceptedRendererSnapshots
    },
    get removedWorktreeFences() {
      return ports().removedWorktreeFences
    },
    get getStore() {
      return ports().getStore
    },
    get restoreLivePairedRendererSessionOwnedMobileTerminals() {
      return ports().bindRuntimeMethod(
        ports().restoreLivePairedRendererSessionOwnedMobileTerminalsMobileSessionReconciliation()
      )
    },
    get getWorkspaceSessionHydrationTargets() {
      return ports().bindRuntimeMethod(ports().getWorkspaceSessionHydrationTargets())
    },
    get hasOffscreenBrowserBackend() {
      return ports().hasOffscreenBrowserBackend
    },
    get drafts() {
      return ports().drafts
    },
    get applyMobileSessionRetirementFences() {
      return ports().bindRuntimeMethod(ports().applyMobileSessionRetirementFences())
    },
    get storeMobileSessionSnapshot() {
      return ports().bindRuntimeMethod(ports().storeMobileSessionSnapshot())
    },
    get removeHeartbeatWorktree() {
      return ports().removeHeartbeatWorktree
    },
    get cancelScheduledMobileSessionTabsChanged() {
      return ports().bindRuntimeMethod(ports().cancelScheduledMobileSessionTabsChanged())
    },
    get notifyMobileSessionTabsRemoved() {
      return ports().bindRuntimeMethod(ports().notifyMobileSessionTabsRemoved())
    },
    get hydrateHeadlessMobileSessionTabsFromWorkspaceSession() {
      return ports().bindRuntimeMethod(
        ports().hydrateHeadlessMobileSessionTabsFromWorkspaceSession()
      )
    },
    get storedMobileSnapshotHasStalePreservedTab() {
      return ports().bindRuntimeMethod(ports().storedMobileSnapshotHasStalePreservedTab())
    },
    get releaseRuntimeSessionOwnershipForRendererRetiredTabs() {
      return ports().bindRuntimeMethod(
        ports().releaseRuntimeSessionOwnershipForRendererRetiredTabs()
      )
    },
    get mergePreservedHeadlessMobileSessionTabs() {
      return ports().bindRuntimeMethod(ports().mergePreservedHeadlessMobileSessionTabs())
    },
    get buildPreservedHeadlessMobileSessionSnapshot() {
      return ports().bindRuntimeMethod(ports().buildPreservedHeadlessMobileSessionSnapshot())
    }
  })
}

export function createRuntimeRendererSessionTerminalRescue(ports: () => SessionLifecyclePorts) {
  return new RuntimeRendererSessionTerminalRescue({
    get ownedPtyIds() {
      return ports().ownedPtyIds
    },
    get ptyRecords() {
      return ports().ptyRecords
    },
    get getSnapshot() {
      return ports().getSnapshot
    },
    get storeMobileSessionSnapshot() {
      return ports().bindRuntimeMethod(ports().storeMobileSessionSnapshot())
    },
    get publishPtyBackedMobileSessionTerminal() {
      return ports().bindRuntimeMethod(ports().publishPtyBackedMobileSessionTerminal())
    }
  })
}

export function createRuntimeSessionGraphLifecycle(ports: () => SessionLifecyclePorts) {
  return new RuntimeSessionGraphLifecycle({
    get state() {
      return ports().state
    },
    get reload() {
      return ports().reload
    },
    get publication() {
      return ports().publication
    },
    get getWaiters() {
      return ports().getWaiters
    },
    get ptys() {
      return ports().ptyRecords
    },
    get resolveWorktreeSelector() {
      return ports().bindRuntimeMethod(ports().resolveWorktreeSelector())
    },
    get handleByPtyIncarnation() {
      return ports().handleByPtyIncarnation
    },
    get handleByPtyId() {
      return ports().handleByPtyId
    },
    get handles() {
      return ports().handles
    },
    get handleByLeafKey() {
      return ports().handleByLeafKey
    },
    get attachWindow() {
      return ports().bindRuntimeMethod(ports().attachWindow())
    },
    get setTerminalSideEffectConsumerAvailable() {
      return ports().bindRuntimeMethod(ports().setTerminalSideEffectConsumerAvailable())
    },
    get rememberDetachedPreAllocatedLeaves() {
      return ports().bindRuntimeMethod(ports().rememberDetachedPreAllocatedLeaves())
    },
    get invalidatePtyIncarnationHandle() {
      return ports().bindRuntimeMethod(ports().invalidatePtyIncarnationHandle())
    },
    get rejectWaitersForHandle() {
      return ports().bindRuntimeMethod(ports().rejectWaitersForHandle())
    },
    get rejectAllWaiters() {
      return ports().bindRuntimeMethod(ports().rejectAllWaiters())
    },
    get refreshWritableFlags() {
      return ports().bindRuntimeMethod(ports().refreshWritableFlags())
    },
    get adoptPreAllocatedHandle() {
      return ports().bindRuntimeMethod(ports().adoptPreAllocatedHandle())
    },
    get reconcilePtyIncarnationHandles() {
      return ports().bindRuntimeMethod(ports().reconcilePtyIncarnationHandles())
    },
    get clearPtyIncarnationHandles() {
      return ports().bindRuntimeMethod(ports().clearPtyIncarnationHandles())
    },
    get shouldRestoreHeadlessGraph() {
      return ports().bindRuntimeMethod(ports().shouldRestoreHeadlessGraph())
    },
    get beginGraphReload() {
      return ports().bindRuntimeMethod(ports().beginGraphReload())
    },
    get restoreHeadlessGraphAuthority() {
      return ports().bindRuntimeMethod(ports().restoreHeadlessGraphAuthority())
    },
    get markSessionTabsInventoryPublished() {
      return ports().bindRuntimeMethod(ports().markSessionTabsInventoryPublished())
    },
    get transitionGraphReloadToTerminalState() {
      return ports().bindRuntimeMethod(ports().transitionGraphReloadToTerminalState())
    },
    get assertGraphReady() {
      return ports().bindRuntimeMethod(ports().assertGraphReady())
    },
    get captureReadyGraphEpoch() {
      return ports().bindRuntimeMethod(ports().captureReadyGraphEpoch())
    },
    get assertStableReadyGraph() {
      return ports().bindRuntimeMethod(ports().assertStableReadyGraph())
    }
  })
}

export function createRuntimeSessionWindowGraph(ports: () => SessionLifecyclePorts) {
  return new RuntimeSessionWindowGraph({
    get state() {
      return ports().state
    },
    get attachWindow() {
      return ports().bindRuntimeMethod(ports().attachWindow())
    },
    get publication() {
      return ports().publication
    },
    get reconcileMobileSessionRetirementFences() {
      return ports().bindRuntimeMethod(ports().reconcileMobileSessionRetirementFences())
    },
    get nextTitleObservationSequence() {
      return ports().bindRuntimeMethod(ports().nextTitleObservationSequence())
    },
    get markPtyColdParked() {
      return ports().markPtyColdParked
    },
    get clearPtyColdParked() {
      return ports().clearPtyColdParked
    },
    get getLeafKey() {
      return ports().bindRuntimeMethod(ports().getLeafKey())
    },
    get getPty() {
      return ports().getPty
    },
    get getPtyLivenessVerdict() {
      return ports().bindRuntimeMethod(ports().getPtyLivenessVerdict())
    },
    get recordPtyWorktree() {
      return ports().bindRuntimeMethod(ports().recordPtyWorktree())
    },
    get makeRuntimePaneKey() {
      return ports().bindRuntimeMethod(ports().makeRuntimePaneKey())
    },
    get adoptFirstPtyForLeafHandle() {
      return ports().bindRuntimeMethod(ports().adoptFirstPtyForLeafHandle())
    },
    get invalidateLeafHandle() {
      return ports().bindRuntimeMethod(ports().invalidateLeafHandle())
    },
    get handleByPtyIncarnation() {
      return ports().handleByPtyIncarnation
    },
    get handleByPtyId() {
      return ports().handleByPtyId
    },
    get handleByLeafKey() {
      return ports().handleByLeafKey
    },
    get rebuildLeafPtyIndex() {
      return ports().bindRuntimeMethod(ports().rebuildLeafPtyIndex())
    },
    get reconcilePtyIncarnationHandles() {
      return ports().bindRuntimeMethod(ports().reconcilePtyIncarnationHandles())
    },
    get snapshots() {
      return ports().getSnapshots
    },
    get storeMobileSessionSnapshot() {
      return ports().bindRuntimeMethod(ports().storeMobileSessionSnapshot())
    },
    get scheduleMobileSessionTabsChanged() {
      return ports().bindRuntimeMethod(ports().scheduleMobileSessionTabsChanged())
    },
    get adoptPreAllocatedHandle() {
      return ports().bindRuntimeMethod(ports().adoptPreAllocatedHandle())
    },
    get hasOrchestrationDb() {
      return ports().hasOrchestrationDb
    },
    get checkDeliverySettledAndArmRecheck() {
      return ports().bindRuntimeMethod(ports().checkDeliverySettledAndArmRecheck())
    },
    get deliverPendingMessagesForLeaf() {
      return ports().bindRuntimeMethod(ports().deliverPendingMessagesForLeaf())
    },
    get agentOrchestration() {
      return ports().agentOrchestration
    },
    get getStatus() {
      return ports().bindRuntimeMethod(ports().getStatus())
    },
    get syncMobileSessionTabs() {
      return ports().bindRuntimeMethod(ports().syncMobileSessionTabs())
    },
    get collectMobileVisibleGraphChangedWorktrees() {
      return ports().bindRuntimeMethod(ports().collectMobileVisibleGraphChangedWorktrees())
    },
    get markGraphReady() {
      return ports().bindRuntimeMethod(ports().markGraphReady())
    },
    get markSessionTabsInventoryPublished() {
      return ports().bindRuntimeMethod(ports().markSessionTabsInventoryPublished())
    },
    get getNativeChatLaunchDraftResolutionClientEventSnapshot() {
      return ports().bindRuntimeMethod(
        ports().getNativeChatLaunchDraftResolutionClientEventSnapshot()
      )
    }
  })
}
