import type {
  CapturedSessionMethodNames,
  createSessionRuntimeMethodBinder
} from './session-runtime-method-readers'
import type {
  RuntimeStructuredSessionTabs,
  RuntimeStructuredSessionTabsHost
} from '../session-tabs/structured-session-tabs'
import type {
  RuntimeSessionTabsInventory,
  RuntimeSessionTabsInventoryHost
} from '../session-tabs/session-tabs-inventory'
import type {
  RuntimeTerminalSurfaceRetirements,
  RuntimeTerminalSurfaceRetirementsHost
} from '../session-tabs/terminal-surface-retirements'
import type {
  RuntimeMobileSessionPreservation,
  RuntimeMobileSessionPreservationHost
} from '../session-tabs/mobile-session-preservation'
import type { mergeStructuredAgentSessionTabGroups } from '../session-tabs/structured-session-tab-groups'
import type {
  RuntimeSessionGraphPromotion,
  RuntimeSessionGraphPromotionHost
} from '../session-graph/session-graph-promotion'
import type {
  RuntimeMobileSessionReconciliation,
  RuntimeMobileSessionReconciliationHost
} from '../session-tabs/mobile-session-reconciliation'
import type { RuntimeMobileSessionHydrationHost } from '../session-tabs/mobile-session-hydration'
import type { RuntimeRendererSessionTerminalRescueHost } from '../session-tabs/renderer-session-terminal-rescue'
import type {
  RuntimeSessionGraphLifecycle,
  RuntimeSessionGraphLifecycleHost
} from '../session-graph/session-graph-lifecycle'
import type { RuntimeSessionWindowGraphHost } from '../session-graph/session-window-graph'
import type { RuntimeHeadlessTerminalTabCloseHost } from '../session-tabs/headless-terminal-tab-close'
import type { RuntimeExplicitTerminalCloseStopsHost } from '../session-tabs/explicit-terminal-close-stops'
import type { RuntimeFloatingSessionLivenessHost } from '../terminal/lifecycle/floating-session-liveness'
import type { createHeadlessSessionTabCommands } from '../session-tabs/headless-session-tab-commands'
import type { TerminalIdentityHost } from '../terminal/identity/terminal-identity-host'
import type { RuntimePtyController } from '../runtime-pty-controller-contract'

type SessionLifecycleCapabilities = {
  bindRuntimeMethod: ReturnType<typeof createSessionRuntimeMethodBinder>
  getValidatedExplicitWorktreeIdSelector: RuntimeSessionTabsInventoryHost['getValidatedExplicitWorktreeIdSelector']
  resolveWorktreeSelector: RuntimeSessionTabsInventoryHost['resolveWorktreeSelector'] &
    RuntimeSessionGraphLifecycleHost['resolveWorktreeSelector']
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession: RuntimeSessionTabsInventoryHost['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'] &
    RuntimeStructuredSessionTabsHost['hydrateHeadlessMobileSessionTabsFromWorkspaceSession']
  refreshMobileSessionPtyRecords: RuntimeSessionTabsInventoryHost['refreshMobileSessionPtyRecords']
  refreshMobileSessionPtyInventory: RuntimeSessionTabsInventoryHost['refreshMobileSessionPtyInventory']
  restoreLivePairedRendererSessionOwnedMobileTerminals: RuntimeSessionTabsInventoryHost['restoreLivePairedRendererSessionOwnedMobileTerminals']
  getMobileSessionTabsForWorktree: RuntimeSessionTabsInventoryHost['getMobileSessionTabsForWorktree']
  getKnownWorkspaceSessionWorktreeIds: RuntimeSessionTabsInventoryHost['getKnownWorkspaceSessionWorktreeIds'] &
    RuntimeStructuredSessionTabsHost['getKnownWorkspaceSessionWorktreeIds']
  getSnapshotValues: RuntimeSessionTabsInventoryHost['getMobileSnapshots']
  projectMobileSessionTabsForClient: RuntimeSessionTabsInventoryHost['projectMobileSessionTabsForClient']
  toMobileSessionTabsResult: RuntimeSessionTabsInventoryHost['toMobileSessionTabsResult'] &
    Parameters<typeof createHeadlessSessionTabCommands>[0]['toMobileSessionTabsResult']
  getChangeSequence: RuntimeSessionTabsInventoryHost['getChangeSequence']
  listKnownExecutionHostIds: RuntimeSessionTabsInventoryHost['listKnownExecutionHostIds']
  publication: RuntimeSessionTabsInventoryHost['publication'] &
    RuntimeSessionGraphLifecycleHost['publication'] &
    RuntimeSessionWindowGraphHost['publication']
  getStore: RuntimeTerminalSurfaceRetirementsHost['getStore'] &
    RuntimeStructuredSessionTabsHost['getStore'] &
    RuntimeMobileSessionHydrationHost['getStore'] &
    RuntimeMobileSessionReconciliationHost['getStore'] &
    RuntimeSessionGraphPromotionHost['getStore']
  tryGetWorkspaceSessionHostIdForWorktree: RuntimeTerminalSurfaceRetirementsHost['tryGetWorkspaceSessionHostIdForWorktree']
  getPtyHandle: RuntimeTerminalSurfaceRetirementsHost['getPtyHandle']
  findHandleForPtyRecord: RuntimeTerminalSurfaceRetirementsHost['findHandleForPtyRecord']
  getSnapshots: RuntimeTerminalSurfaceRetirementsHost['getMobileSnapshots'] &
    RuntimeStructuredSessionTabsHost['getMobileSnapshots'] &
    RuntimeMobileSessionReconciliationHost['snapshots'] &
    RuntimeSessionWindowGraphHost['snapshots']
  getTopologyRevisions: RuntimeTerminalSurfaceRetirementsHost['getTopologyRevisions']
  storeMobileSessionSnapshot: RuntimeTerminalSurfaceRetirementsHost['storeMobileSessionSnapshot']
  notifyMobileSessionTabsChanged: RuntimeTerminalSurfaceRetirementsHost['notifyMobileSessionTabsChanged']
  prepareStructuredAgentSessionStartupRestoration: RuntimeStructuredSessionTabsHost['prepareStructuredAgentSessionStartupRestoration']
  hasPersistedStructuredAgentSessionStore: RuntimeStructuredSessionTabsHost['hasPersistedStructuredAgentSessionStore']
  notifyMobileSessionTabSnapshots: RuntimeStructuredSessionTabsHost['notifyMobileSessionTabSnapshots']
  emitMobileSessionTabsSnapshot: RuntimeStructuredSessionTabsHost['emitMobileSessionTabsSnapshot'] &
    RuntimeHeadlessTerminalTabCloseHost['emitMobileSessionTabsSnapshot'] &
    Parameters<typeof createHeadlessSessionTabCommands>[0]['emitMobileSessionTabsSnapshot']
  getWorkspaceSessionForWorktree: RuntimeMobileSessionPreservationHost['getWorkspaceSessionForWorktree'] &
    RuntimeMobileSessionHydrationHost['getWorkspaceSessionForWorktree'] &
    Parameters<typeof createHeadlessSessionTabCommands>[0]['getWorkspaceSessionForWorktree']
  isMobileTerminalCreatePending: RuntimeMobileSessionPreservationHost['isMobileTerminalCreatePending']
  hasLiveRuntimeSessionOwnedPtyBinding: RuntimeMobileSessionPreservationHost['hasLiveRuntimeSessionOwnedPtyBinding']
  hasLiveOrPersistedServeOrSshOwnedPtyBinding: RuntimeMobileSessionPreservationHost['hasLiveOrPersistedServeOrSshOwnedPtyBinding']
  clearRuntimeSessionOwnershipForMobileTab: RuntimeMobileSessionPreservationHost['clearRuntimeSessionOwnershipForMobileTab']
  getPty: RuntimeMobileSessionPreservationHost['getPty'] &
    RuntimeSessionWindowGraphHost['getPty'] &
    RuntimeExplicitTerminalCloseStopsHost['getPty']
  setPairedRendererSessionOwnership: RuntimeMobileSessionPreservationHost['setPairedRendererSessionOwnership'] &
    RuntimeHeadlessTerminalTabCloseHost['setPairedRendererSessionOwnership']
  getClientBrowserPage: RuntimeMobileSessionPreservationHost['getClientBrowserPage']
  hasOffscreenBrowserBackend: RuntimeMobileSessionPreservationHost['hasOffscreenBrowserBackend'] &
    RuntimeMobileSessionHydrationHost['hasOffscreenBrowserBackend'] &
    RuntimeMobileSessionReconciliationHost['hasOffscreenBrowserBackend']
  getLiveBrowserTabsByPageId: RuntimeMobileSessionPreservationHost['getLiveBrowserTabsByPageId']
  hasAuthoritativeWindow: RuntimeMobileSessionHydrationHost['hasAuthoritativeWindow']
  countClientBrowserPages: RuntimeMobileSessionHydrationHost['countClientBrowserPages']
  workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate: RuntimeMobileSessionHydrationHost['workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate']
  workspaceSessionHasRuntimeOwnedPtyCandidate: RuntimeMobileSessionHydrationHost['workspaceSessionHasRuntimeOwnedPtyCandidate']
  getSnapshot: RuntimeMobileSessionHydrationHost['getSnapshot'] &
    RuntimeRendererSessionTerminalRescueHost['getSnapshot'] &
    RuntimeHeadlessTerminalTabCloseHost['getSnapshot'] &
    RuntimeFloatingSessionLivenessHost['getSnapshot'] &
    Parameters<typeof createHeadlessSessionTabCommands>[0]['getMobileSessionSnapshot']
  reconcileHeadlessMobileSessionBrowserTabs: RuntimeMobileSessionHydrationHost['reconcileHeadlessMobileSessionBrowserTabs']
  hasServeOrSshOwnedBinding: RuntimeMobileSessionHydrationHost['hasServeOrSshOwnedBinding']
  hasRecentExpiredSshLeasePane: RuntimeMobileSessionHydrationHost['hasRecentExpiredSshLeasePane']
  buildHeadlessMobileSessionBrowserTabs: RuntimeMobileSessionHydrationHost['buildHeadlessMobileSessionBrowserTabs']
  isHeadlessBuiltMobileSessionPublicationBase: RuntimeMobileSessionHydrationHost['isHeadlessBuiltMobileSessionPublicationBase']
  getMergedMobileSessionPublicationEpoch: RuntimeMobileSessionHydrationHost['getMergedMobileSessionPublicationEpoch']
  acceptedRendererSnapshots: RuntimeMobileSessionReconciliationHost['acceptedRendererSnapshots']
  removedWorktreeFences: RuntimeMobileSessionReconciliationHost['removedWorktreeFences']
  restoreLivePairedRendererSessionOwnedMobileTerminalsMobileSessionReconciliation: RuntimeMobileSessionReconciliationHost['restoreLivePairedRendererSessionOwnedMobileTerminals']
  getWorkspaceSessionHydrationTargets: RuntimeMobileSessionReconciliationHost['getWorkspaceSessionHydrationTargets']
  drafts: RuntimeMobileSessionReconciliationHost['drafts']
  applyMobileSessionRetirementFences: RuntimeMobileSessionReconciliationHost['applyMobileSessionRetirementFences']
  removeHeartbeatWorktree: RuntimeMobileSessionReconciliationHost['removeHeartbeatWorktree']
  cancelScheduledMobileSessionTabsChanged: RuntimeMobileSessionReconciliationHost['cancelScheduledMobileSessionTabsChanged']
  notifyMobileSessionTabsRemoved: RuntimeMobileSessionReconciliationHost['notifyMobileSessionTabsRemoved']
  ownedPtyIds: RuntimeRendererSessionTerminalRescueHost['ownedPtyIds']
  ptyRecords(): ReturnType<RuntimeRendererSessionTerminalRescueHost['ptyRecords']> &
    ReturnType<RuntimeSessionGraphLifecycleHost['ptys']> &
    ReturnType<RuntimeFloatingSessionLivenessHost['ptys']> &
    ReturnType<TerminalIdentityHost['ptysById']>
  publishPtyBackedMobileSessionTerminal: RuntimeRendererSessionTerminalRescueHost['publishPtyBackedMobileSessionTerminal']
  state: RuntimeSessionGraphLifecycleHost['state'] &
    RuntimeSessionWindowGraphHost['state'] &
    RuntimeSessionGraphPromotionHost['state']
  reload: RuntimeSessionGraphLifecycleHost['reload']
  getWaiters: RuntimeSessionGraphLifecycleHost['getWaiters']
  handleByPtyIncarnation: RuntimeSessionGraphLifecycleHost['handleByPtyIncarnation'] &
    RuntimeSessionWindowGraphHost['handleByPtyIncarnation']
  handleByPtyId: RuntimeSessionGraphLifecycleHost['handleByPtyId'] &
    RuntimeSessionWindowGraphHost['handleByPtyId']
  handles: RuntimeSessionGraphLifecycleHost['handles']
  handleByLeafKey: RuntimeSessionGraphLifecycleHost['handleByLeafKey'] &
    RuntimeSessionWindowGraphHost['handleByLeafKey']
  attachWindow: RuntimeSessionGraphLifecycleHost['attachWindow'] &
    RuntimeSessionWindowGraphHost['attachWindow']
  setTerminalSideEffectConsumerAvailable: RuntimeSessionGraphLifecycleHost['setTerminalSideEffectConsumerAvailable']
  rememberDetachedPreAllocatedLeaves: RuntimeSessionGraphLifecycleHost['rememberDetachedPreAllocatedLeaves']
  invalidatePtyIncarnationHandle: RuntimeSessionGraphLifecycleHost['invalidatePtyIncarnationHandle']
  rejectWaitersForHandle: RuntimeSessionGraphLifecycleHost['rejectWaitersForHandle']
  rejectAllWaiters: RuntimeSessionGraphLifecycleHost['rejectAllWaiters']
  refreshWritableFlags: RuntimeSessionGraphLifecycleHost['refreshWritableFlags']
  adoptPreAllocatedHandle: RuntimeSessionGraphLifecycleHost['adoptPreAllocatedHandle'] &
    RuntimeSessionWindowGraphHost['adoptPreAllocatedHandle']
  reconcilePtyIncarnationHandles: RuntimeSessionGraphLifecycleHost['reconcilePtyIncarnationHandles'] &
    RuntimeSessionWindowGraphHost['reconcilePtyIncarnationHandles']
  clearPtyIncarnationHandles: RuntimeSessionGraphLifecycleHost['clearPtyIncarnationHandles']
  handleGraphReloadTimeout: RuntimeSessionGraphLifecycle['handleGraphReloadTimeout']
  reconcileMobileSessionRetirementFences: RuntimeSessionWindowGraphHost['reconcileMobileSessionRetirementFences']
  nextTitleObservationSequence: RuntimeSessionWindowGraphHost['nextTitleObservationSequence']
  markPtyColdParked: RuntimeSessionWindowGraphHost['markPtyColdParked']
  clearPtyColdParked: RuntimeSessionWindowGraphHost['clearPtyColdParked']
  getLeafKey: RuntimeSessionWindowGraphHost['getLeafKey']
  getPtyLivenessVerdict: RuntimeSessionWindowGraphHost['getPtyLivenessVerdict'] &
    RuntimeExplicitTerminalCloseStopsHost['getPtyLivenessVerdict']
  recordPtyWorktree: RuntimeSessionWindowGraphHost['recordPtyWorktree'] &
    RuntimeFloatingSessionLivenessHost['recordPtyWorktree']
  makeRuntimePaneKey: RuntimeSessionWindowGraphHost['makeRuntimePaneKey']
  adoptFirstPtyForLeafHandle: RuntimeSessionWindowGraphHost['adoptFirstPtyForLeafHandle']
  invalidateLeafHandle: RuntimeSessionWindowGraphHost['invalidateLeafHandle']
  rebuildLeafPtyIndex: RuntimeSessionWindowGraphHost['rebuildLeafPtyIndex']
  scheduleMobileSessionTabsChanged: RuntimeSessionWindowGraphHost['scheduleMobileSessionTabsChanged']
  hasOrchestrationDb: RuntimeSessionWindowGraphHost['hasOrchestrationDb']
  checkDeliverySettledAndArmRecheck: RuntimeSessionWindowGraphHost['checkDeliverySettledAndArmRecheck']
  deliverPendingMessagesForLeaf: RuntimeSessionWindowGraphHost['deliverPendingMessagesForLeaf']
  agentOrchestration: RuntimeSessionWindowGraphHost['agentOrchestration']
  getStatus: RuntimeSessionWindowGraphHost['getStatus']
  getMobileSessionTerminalRetirementProof: RuntimeHeadlessTerminalTabCloseHost['getMobileSessionTerminalRetirementProof']
  captureTerminalTabRetirement: RuntimeHeadlessTerminalTabCloseHost['captureTerminalTabRetirement']
  closeTerminalSurface: RuntimeHeadlessTerminalTabCloseHost['closeTerminalSurface']
  clearRuntimeSessionOwnershipForMobileTabHeadlessTerminalTabClose: RuntimeHeadlessTerminalTabCloseHost['clearRuntimeSessionOwnershipForMobileTab']
  getMobileTerminalLeafPtyIds: RuntimeHeadlessTerminalTabCloseHost['getMobileTerminalLeafPtyIds']
  findPtyForMobileTerminalTab: RuntimeHeadlessTerminalTabCloseHost['findPtyForMobileTerminalTab']
  getPtyController(): ReturnType<RuntimeHeadlessTerminalTabCloseHost['getPtyController']> &
    ReturnType<RuntimeExplicitTerminalCloseStopsHost['getPtyController']> &
    ReturnType<RuntimeFloatingSessionLivenessHost['getPtyController']> &
    (Pick<RuntimePtyController, 'kill' | 'getForegroundProcess'> | null)
  markPtyStopRequested: RuntimeExplicitTerminalCloseStopsHost['markPtyStopRequested']
  markPtyLivenessUnverifiable: RuntimeExplicitTerminalCloseStopsHost['markPtyLivenessUnverifiable']
  getMobileTerminalPaneKey: RuntimeFloatingSessionLivenessHost['getMobileTerminalPaneKey']
  leaves: RuntimeFloatingSessionLivenessHost['leaves']
  markPtyLivenessLive: RuntimeFloatingSessionLivenessHost['markPtyLivenessLive']
  refreshPtyForegroundAgent: RuntimeFloatingSessionLivenessHost['refreshPtyForegroundAgent']
  leafExistsForPty: RuntimeFloatingSessionLivenessHost['leafExistsForPty']
  pruneDisconnectedPtyRecords: RuntimeFloatingSessionLivenessHost['pruneDisconnectedPtyRecords']
  getPtyValues: RuntimeSessionGraphPromotionHost['ptys']
  getWorkspaceSessionHostIdForWorktree: RuntimeSessionGraphPromotionHost['getWorkspaceSessionHostIdForWorktree']
  canPersistWorkspaceSession: Parameters<
    typeof createHeadlessSessionTabCommands
  >[0]['canPersistWorkspaceSession']
  readWorkspaceSessionWriter: Parameters<
    typeof createHeadlessSessionTabCommands
  >[0]['setWorkspaceSessionForWorktree']
  resolveMobileSessionHostTabId: Parameters<
    typeof createHeadlessSessionTabCommands
  >[0]['resolveMobileSessionHostTabId']
  normalizeMobileSessionTabOrder: Parameters<
    typeof createHeadlessSessionTabCommands
  >[0]['normalizeMobileSessionTabOrder']
  projectStructuredAgentSessionTab: RuntimeStructuredSessionTabs['projectStructuredAgentSessionTab']
  retireStructuredAgentSessionTabFromSnapshot: RuntimeStructuredSessionTabs['retireStructuredAgentSessionTabFromSnapshot']
  restoreStructuredAgentSessionTabsOnce: RuntimeStructuredSessionTabs['restoreStructuredAgentSessionTabsOnce']
  listAllMobileSessionTabsWithChangeSequence: RuntimeSessionTabsInventory['listAllMobileSessionTabsWithChangeSequence']
  collectAllMobileSessionTabs: RuntimeSessionTabsInventory['collectAllMobileSessionTabs']
  listAllMobileSessionTabsInventoryWithChangeSequence: RuntimeSessionTabsInventory['listAllMobileSessionTabsInventoryWithChangeSequence']
  assertSessionTabsInventoryRequestActive: RuntimeSessionTabsInventory['assertSessionTabsInventoryRequestActive']
  getAuthoritativeSessionTabsInventoryEpoch: RuntimeSessionTabsInventory['getAuthoritativeSessionTabsInventoryEpoch']
  settleSessionTabsInventory: RuntimeSessionTabsInventory['settleSessionTabsInventory']
  waitForSessionTabsInventoryPublication: RuntimeSessionTabsInventory['waitForSessionTabsInventoryPublication']
  isCompleteSessionTabsPtyCensus: RuntimeSessionTabsInventory['isCompleteSessionTabsPtyCensus']
  stageTerminalSurfaceRetirements: RuntimeTerminalSurfaceRetirements['stageTerminalSurfaceRetirements']
  publishRetiredTerminalSurfaceProofs: RuntimeTerminalSurfaceRetirements['publishRetiredTerminalSurfaceProofs']
  persistStagedTerminalSurfaceRetirements: RuntimeTerminalSurfaceRetirements['persistStagedTerminalSurfaceRetirements']
  collectPreservedHeadlessMobileSessionTabs: RuntimeMobileSessionPreservation['collectPreservedHeadlessMobileSessionTabs']
  mergeStructuredAgentSessionTabGroups: typeof mergeStructuredAgentSessionTabGroups
  shouldPreserveHeadlessMobileSessionTab: RuntimeMobileSessionPreservation['shouldPreserveHeadlessMobileSessionTab']
  storedMobileSnapshotHasStalePreservedTab: RuntimeMobileSessionPreservation['storedMobileSnapshotHasStalePreservedTab']
  releaseRuntimeSessionOwnershipForRendererRetiredTabs: RuntimeMobileSessionPreservation['releaseRuntimeSessionOwnershipForRendererRetiredTabs']
  mergePreservedHeadlessMobileSessionTabs: RuntimeMobileSessionPreservation['mergePreservedHeadlessMobileSessionTabs']
  buildPreservedHeadlessMobileSessionSnapshot: RuntimeMobileSessionPreservation['buildPreservedHeadlessMobileSessionSnapshot']
  persistWindowlessPtyBindingsForDesktopAttach: RuntimeSessionGraphPromotion['persistWindowlessPtyBindingsForDesktopAttach']
  beginGraphReload: RuntimeSessionGraphLifecycle['beginGraphReload']
  shouldRestoreHeadlessGraph: RuntimeSessionGraphLifecycle['shouldRestoreHeadlessGraph']
  restoreHeadlessGraphAuthority: RuntimeSessionGraphLifecycle['restoreHeadlessGraphAuthority']
  markSessionTabsInventoryPublished: RuntimeSessionTabsInventory['markSessionTabsInventoryPublished']
  transitionGraphReloadToTerminalState: RuntimeSessionGraphLifecycle['transitionGraphReloadToTerminalState']
  assertGraphReady: RuntimeSessionGraphLifecycle['assertGraphReady']
  captureReadyGraphEpoch: RuntimeSessionGraphLifecycle['captureReadyGraphEpoch']
  assertStableReadyGraph: RuntimeSessionGraphLifecycle['assertStableReadyGraph']
  syncMobileSessionTabs: RuntimeMobileSessionReconciliation['syncMobileSessionTabs']
  collectMobileVisibleGraphChangedWorktrees: RuntimeSessionWindowGraphHost['collectMobileVisibleGraphChangedWorktrees']
  markGraphReady: RuntimeSessionGraphLifecycle['markGraphReady']
  getNativeChatLaunchDraftResolutionClientEventSnapshot: RuntimeSessionWindowGraphHost['getNativeChatLaunchDraftResolutionClientEventSnapshot']
}

export type SessionLifecyclePorts = Omit<
  SessionLifecycleCapabilities,
  CapturedSessionMethodNames
> & {
  [Name in CapturedSessionMethodNames]: () => SessionLifecycleCapabilities[Name]
}
