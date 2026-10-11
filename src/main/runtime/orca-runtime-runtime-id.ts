// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.

import { createSessionRuntimeMethodBinder } from './session-construction/session-runtime-method-readers'

import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

import { RuntimeSessionLifecycleOwners } from './session-construction/session-lifecycle-owners'
import type { SessionLifecyclePorts } from './session-construction/session-lifecycle-ports'
import { randomUUID } from 'node:crypto'

import { createSessionTerminalIdentityOwner } from './session-construction/session-terminal-identity'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeClientSettingsController } from './runtime-client-settings'
import type { RuntimeAutomationController } from './runtime-automation-controller'
import { RuntimeArtifactController } from './runtime-artifact-controller'
import type { OrchestrationEnvironmentTransport } from './orchestration/environment-transport'
import type { RuntimeOrchestrationFederation } from './runtime-orchestration-federation'

import { ClientHostedPageReconciliationWindow } from './client-hosted-page-reconciliation-window'

import { WorktreeTerminalMutationLock } from './worktree-terminal-mutation-lock'
import { RemoteRuntimeTerminalCreateIdempotency } from './remote-runtime-terminal-create-idempotency'

import type { MobileSessionTabsNotifyCoalescer } from './mobile-session-tabs-notify-coalescer'
import { createMobileSessionTabsNotifyCoalescer } from './mobile-session-tabs-notify-coalescer'
import type { MobileSessionTabsAgentStatusHeartbeat } from './mobile-session-tabs-agent-status-heartbeat'
import { createMobileSessionTabsAgentStatusHeartbeat } from './mobile-session-tabs-agent-status-heartbeat'

import { MailPointerRepointScheduler } from './orchestration/mail-pointer-repoint-scheduler'
import { RuntimeTerminalWaiterRegistry } from './terminal/wait/terminal-waiter-registry'
import { RuntimeTerminalWriter } from './runtime-terminal-writer'
import { writeRefused } from '../../shared/pty-write-settlement'
import { createSessionTerminalIdlePolls } from './session-construction/session-terminal-idle-polls'
import { TerminalIntentionalStops } from './terminal-intentional-stops'
import { TerminalRunFactsRegister, type TerminalSpawnCommit } from './terminal-run-facts'
import type { TuiIdleEvidenceSource } from './tui-idle-evidence-source'
import { TUI_IDLE_DEFAULT_TIMEOUT_MS, TUI_IDLE_QUIESCENCE_MS } from './orca-runtime-postlude'
import { RuntimeTerminalWait as RuntimeTerminalWaitController } from './terminal/wait/terminal-wait'

export class OrcaRuntimeWithRuntimeId extends RuntimeSessionLifecycleOwners {
  protected readonly runtimeId = randomUUID()

  protected readonly startedAt = Date.now()

  protected readonly store: RuntimeStore | null

  protected readonly clientSettings: RuntimeClientSettingsController

  protected readonly automation: RuntimeAutomationController

  protected readonly artifacts = new RuntimeArtifactController()

  protected readonly orchestrationEnvironmentTransport: OrchestrationEnvironmentTransport | null

  protected readonly orchestrationFederation: RuntimeOrchestrationFederation

  protected readonly sessionPorts: SessionLifecyclePorts = {
    bindRuntimeMethod: createSessionRuntimeMethodBinder(this),
    getValidatedExplicitWorktreeIdSelector: () => this.getValidatedExplicitWorktreeIdSelector,
    resolveWorktreeSelector: () => this.resolveWorktreeSelector,
    hydrateHeadlessMobileSessionTabsFromWorkspaceSession: () =>
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession,
    refreshMobileSessionPtyRecords: () => this.refreshMobileSessionPtyRecords,
    refreshMobileSessionPtyInventory: () => this.refreshMobileSessionPtyInventory,
    restoreLivePairedRendererSessionOwnedMobileTerminals: () =>
      this.restoreLivePairedRendererSessionOwnedMobileTerminals,
    getMobileSessionTabsForWorktree: () => this.getMobileSessionTabsForWorktree,
    getKnownWorkspaceSessionWorktreeIds: () => this.getKnownWorkspaceSessionWorktreeIds,
    getSnapshotValues: () => this.mobileSessionTabsByWorktree.values(),
    projectMobileSessionTabsForClient: () => this.projectMobileSessionTabsForClient,
    toMobileSessionTabsResult: () => this.toMobileSessionTabsResult,
    getChangeSequence: () => this.mobileSessionTabsChangeSequence,
    listKnownExecutionHostIds: () => this.listKnownExecutionHostIds,
    publication: this.sessionTabsInventoryPublication,
    getStore: () => this.store,
    tryGetWorkspaceSessionHostIdForWorktree: () => this.tryGetWorkspaceSessionHostIdForWorktree,
    getPtyHandle: (ptyId) => this.handleByPtyId.get(ptyId),
    findHandleForPtyRecord: () => this.findHandleForPtyRecord,
    getSnapshots: () => this.mobileSessionTabsByWorktree,
    getTopologyRevisions: () => this.terminalTopologyRevisionByRepoId,
    storeMobileSessionSnapshot: () => this.storeMobileSessionSnapshot,
    notifyMobileSessionTabsChanged: () => this.notifyMobileSessionTabsChanged,
    prepareStructuredAgentSessionStartupRestoration: () =>
      this.prepareStructuredAgentSessionStartupRestoration,
    hasPersistedStructuredAgentSessionStore: () => this.hasPersistedStructuredAgentSessionStore,
    notifyMobileSessionTabSnapshots: () => this.notifyMobileSessionTabSnapshots,
    emitMobileSessionTabsSnapshot: () => this.emitMobileSessionTabsSnapshot,
    getWorkspaceSessionForWorktree: () => this.getWorkspaceSessionForWorktree,
    isMobileTerminalCreatePending: (key) => this.pendingMobileTerminalCreatesByKey.has(key),
    hasLiveRuntimeSessionOwnedPtyBinding: () => this.hasLiveRuntimeSessionOwnedPtyBinding,
    hasLiveOrPersistedServeOrSshOwnedPtyBinding: () =>
      this.hasLiveOrPersistedServeOrSshOwnedPtyBinding,
    clearRuntimeSessionOwnershipForMobileTab: () => this.clearRuntimeSessionOwnershipForMobileTab,
    getPty: (ptyId) => this.ptysById.get(ptyId),
    setPairedRendererSessionOwnership: () => this.setPairedRendererSessionOwnership,
    getClientBrowserPage: (browserPageId) =>
      getRuntimeBrowserPageRegistry(this).getPage(browserPageId),
    hasOffscreenBrowserBackend: () => Boolean(this.offscreenBrowserBackend),
    getLiveBrowserTabsByPageId: () => this.getLiveBrowserTabsByPageId,
    hasAuthoritativeWindow: () => Boolean(this.getAvailableAuthoritativeWindow()),
    countClientBrowserPages: (worktreeId) =>
      getRuntimeBrowserPageRegistry(this).listPages(worktreeId).length,
    workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate: () =>
      this.workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate,
    workspaceSessionHasRuntimeOwnedPtyCandidate: () =>
      this.workspaceSessionHasRuntimeOwnedPtyCandidate,
    getSnapshot: (worktreeId) => this.mobileSessionTabsByWorktree.get(worktreeId),
    reconcileHeadlessMobileSessionBrowserTabs: () => this.reconcileHeadlessMobileSessionBrowserTabs,
    hasServeOrSshOwnedBinding: () => this.hasServeOrSshOwnedBinding,
    hasRecentExpiredSshLeasePane: () => this.hasRecentExpiredSshLeasePane,
    buildHeadlessMobileSessionBrowserTabs: () => this.buildHeadlessMobileSessionBrowserTabs,
    isHeadlessBuiltMobileSessionPublicationBase: () =>
      this.isHeadlessBuiltMobileSessionPublicationBase,
    getMergedMobileSessionPublicationEpoch: () => this.getMergedMobileSessionPublicationEpoch,
    acceptedRendererSnapshots: () => this.acceptedRendererMobileSnapshotByWorktree,
    removedWorktreeFences: () => this.removedMobileSessionWorktreeIds,
    restoreLivePairedRendererSessionOwnedMobileTerminalsMobileSessionReconciliation: () =>
      this.restoreLivePairedRendererSessionOwnedMobileTerminals,
    getWorkspaceSessionHydrationTargets: () => this.getWorkspaceSessionHydrationTargets,
    drafts: () => this.nativeChatDraftResolutions,
    applyMobileSessionRetirementFences: () => this.applyMobileSessionRetirementFences,
    removeHeartbeatWorktree: (worktreeId) =>
      this.mobileSessionTabsAgentStatusHeartbeat.removeWorktree(worktreeId),
    cancelScheduledMobileSessionTabsChanged: () => this.cancelScheduledMobileSessionTabsChanged,
    notifyMobileSessionTabsRemoved: () => this.notifyMobileSessionTabsRemoved,
    ownedPtyIds: () => this.pairedRendererSessionOwnedPtyIds,
    ptyRecords: () => this.ptysById,
    publishPtyBackedMobileSessionTerminal: () => this.publishPtyBackedMobileSessionTerminal,
    state: this.runtimeGraphState,
    reload: this.graphReloadLifecycle,
    getWaiters: () => this.terminalWaiters,
    handleByPtyIncarnation: () => this.handleByPtyIncarnation,
    handleByPtyId: () => this.handleByPtyId,
    handles: () => this.handles,
    handleByLeafKey: () => this.handleByLeafKey,
    attachWindow: () => this.attachWindow,
    setTerminalSideEffectConsumerAvailable: () => this.setTerminalSideEffectConsumerAvailable,
    rememberDetachedPreAllocatedLeaves: () => this.rememberDetachedPreAllocatedLeaves,
    invalidatePtyIncarnationHandle: () => this.invalidatePtyIncarnationHandle,
    rejectWaitersForHandle: () => this.rejectWaitersForHandle,
    rejectAllWaiters: () => this.rejectAllWaiters,
    refreshWritableFlags: () => this.refreshWritableFlags,
    adoptPreAllocatedHandle: () => this.adoptPreAllocatedHandle,
    reconcilePtyIncarnationHandles: () => this.reconcilePtyIncarnationHandles,
    clearPtyIncarnationHandles: () => this.clearPtyIncarnationHandles,
    handleGraphReloadTimeout: () => this.handleGraphReloadTimeout,
    reconcileMobileSessionRetirementFences: () => this.reconcileMobileSessionRetirementFences,
    nextTitleObservationSequence: () => this.nextTitleObservationSequence,
    markPtyColdParked: (ptyId) => this.orchestrationMailboxPointerDelivery.markPtyColdParked(ptyId),
    clearPtyColdParked: (ptyId) =>
      this.orchestrationMailboxPointerDelivery.clearPtyColdParked(ptyId),
    getLeafKey: () => this.getLeafKey,
    getPtyLivenessVerdict: () => this.getPtyLivenessVerdict,
    recordPtyWorktree: () => this.recordPtyWorktree,
    makeRuntimePaneKey: () => this.makeRuntimePaneKey,
    adoptFirstPtyForLeafHandle: () => this.adoptFirstPtyForLeafHandle,
    invalidateLeafHandle: () => this.invalidateLeafHandle,
    rebuildLeafPtyIndex: () => this.rebuildLeafPtyIndex,
    scheduleMobileSessionTabsChanged: () => this.scheduleMobileSessionTabsChanged,
    hasOrchestrationDb: () => Boolean(this._orchestrationDb),
    checkDeliverySettledAndArmRecheck: () => this.checkDeliverySettledAndArmRecheck,
    deliverPendingMessagesForLeaf: () => this.deliverPendingMessagesForLeaf,
    agentOrchestration: () => this.agentOrchestrationProjection,
    getStatus: () => this.getStatus,
    getMobileSessionTerminalRetirementProof: () => this.getMobileSessionTerminalRetirementProof,
    captureTerminalTabRetirement: () => this.captureTerminalTabRetirement,
    closeTerminalSurface: () => this.closeTerminalSurface,
    clearRuntimeSessionOwnershipForMobileTabHeadlessTerminalTabClose: () =>
      this.clearRuntimeSessionOwnershipForMobileTab,
    getMobileTerminalLeafPtyIds: () => this.getMobileTerminalLeafPtyIds,
    findPtyForMobileTerminalTab: () => this.findPtyForMobileTerminalTab,
    getPtyController: () => this.ptyController,
    markPtyStopRequested: () => this.markPtyStopRequested,
    markPtyLivenessUnverifiable: () => this.markPtyLivenessUnverifiable,
    getMobileTerminalPaneKey: () => this.getMobileTerminalPaneKey,
    leaves: () => this.leaves.values(),
    markPtyLivenessLive: () => this.markPtyLivenessLive,
    refreshPtyForegroundAgent: () => this.refreshPtyForegroundAgent,
    leafExistsForPty: () => this.leafExistsForPty,
    pruneDisconnectedPtyRecords: () => this.pruneDisconnectedPtyRecords,
    getPtyValues: () => this.ptysById.values(),
    getWorkspaceSessionHostIdForWorktree: () => this.getWorkspaceSessionHostIdForWorktree,
    canPersistWorkspaceSession: () => Boolean(this.store?.setWorkspaceSession),
    readWorkspaceSessionWriter: () => this.setWorkspaceSessionForWorktree,
    resolveMobileSessionHostTabId: () => this.resolveMobileSessionHostTabId,
    normalizeMobileSessionTabOrder: () => this.normalizeMobileSessionTabOrder,
    projectStructuredAgentSessionTab: () => this.projectStructuredAgentSessionTab,
    retireStructuredAgentSessionTabFromSnapshot: () =>
      this.retireStructuredAgentSessionTabFromSnapshot,
    restoreStructuredAgentSessionTabsOnce: () => this.restoreStructuredAgentSessionTabsOnce,
    listAllMobileSessionTabsWithChangeSequence: () =>
      this.listAllMobileSessionTabsWithChangeSequence,
    collectAllMobileSessionTabs: () => this.collectAllMobileSessionTabs,
    listAllMobileSessionTabsInventoryWithChangeSequence: () =>
      this.listAllMobileSessionTabsInventoryWithChangeSequence,
    assertSessionTabsInventoryRequestActive: () => this.assertSessionTabsInventoryRequestActive,
    getAuthoritativeSessionTabsInventoryEpoch: () => this.getAuthoritativeSessionTabsInventoryEpoch,
    settleSessionTabsInventory: () => this.settleSessionTabsInventory,
    waitForSessionTabsInventoryPublication: () => this.waitForSessionTabsInventoryPublication,
    isCompleteSessionTabsPtyCensus: () => this.isCompleteSessionTabsPtyCensus,
    stageTerminalSurfaceRetirements: () => this.stageTerminalSurfaceRetirements,
    publishRetiredTerminalSurfaceProofs: () => this.publishRetiredTerminalSurfaceProofs,
    persistStagedTerminalSurfaceRetirements: () => this.persistStagedTerminalSurfaceRetirements,
    collectPreservedHeadlessMobileSessionTabs: () => this.collectPreservedHeadlessMobileSessionTabs,
    mergeStructuredAgentSessionTabGroups: () => this.mergeStructuredAgentSessionTabGroups,
    shouldPreserveHeadlessMobileSessionTab: () => this.shouldPreserveHeadlessMobileSessionTab,
    storedMobileSnapshotHasStalePreservedTab: () => this.storedMobileSnapshotHasStalePreservedTab,
    releaseRuntimeSessionOwnershipForRendererRetiredTabs: () =>
      this.releaseRuntimeSessionOwnershipForRendererRetiredTabs,
    mergePreservedHeadlessMobileSessionTabs: () => this.mergePreservedHeadlessMobileSessionTabs,
    buildPreservedHeadlessMobileSessionSnapshot: () =>
      this.buildPreservedHeadlessMobileSessionSnapshot,
    persistWindowlessPtyBindingsForDesktopAttach: () =>
      this.persistWindowlessPtyBindingsForDesktopAttach,
    beginGraphReload: () => this.beginGraphReload,
    shouldRestoreHeadlessGraph: () => this.shouldRestoreHeadlessGraph,
    restoreHeadlessGraphAuthority: () => this.restoreHeadlessGraphAuthority,
    markSessionTabsInventoryPublished: () => this.markSessionTabsInventoryPublished,
    transitionGraphReloadToTerminalState: () => this.transitionGraphReloadToTerminalState,
    assertGraphReady: () => this.assertGraphReady,
    captureReadyGraphEpoch: () => this.captureReadyGraphEpoch,
    assertStableReadyGraph: () => this.assertStableReadyGraph,
    syncMobileSessionTabs: () => this.syncMobileSessionTabs,
    collectMobileVisibleGraphChangedWorktrees: () => this.collectMobileVisibleGraphChangedWorktrees,
    markGraphReady: () => this.markGraphReady,
    getNativeChatLaunchDraftResolutionClientEventSnapshot: () =>
      this.getNativeChatLaunchDraftResolutionClientEventSnapshot
  }

  protected readonly clientHostedPageReconciliation = new ClientHostedPageReconciliationWindow(
    Date.now()
  )

  protected readonly terminalCreateIdempotency = new RemoteRuntimeTerminalCreateIdempotency()

  protected readonly terminalMutationLock = new WorktreeTerminalMutationLock()

  // Why public: the PTY IPC layer's stop paths write it and its exit delivery reads it.
  readonly intentionalPtyStops = new TerminalIntentionalStops()

  readonly terminalRunFacts = new TerminalRunFactsRegister()

  /** Both spawn-commit funnels report each committed process here, once. */
  noteTerminalSpawnCommit(commit: TerminalSpawnCommit, expectedSourceBinding?: unknown): void {
    this.terminalRunFacts.recordSpawnCommit(commit, expectedSourceBinding)
    this.intentionalPtyStops.noteSpawnCommit(commit.id)
  }

  // Coalesce title/status notifications and emit the latest session snapshot.
  protected readonly mobileSessionTabsNotifyCoalescer: MobileSessionTabsNotifyCoalescer =
    createMobileSessionTabsNotifyCoalescer((worktreeId) =>
      this.flushScheduledMobileSessionTabsChanged(worktreeId)
    )

  protected readonly mobileSessionTabsAgentStatusHeartbeat: MobileSessionTabsAgentStatusHeartbeat =
    createMobileSessionTabsAgentStatusHeartbeat(
      (ptyId) => this.getMobileSessionWorktreeIdsForPty(ptyId),
      (worktreeId) => this.touchMobileSessionTabsForWorktree(worktreeId)
    )

  protected readonly terminalIdentity = createSessionTerminalIdentityOwner(this.sessionPorts, {
    runtimeId: () => this.runtimeId,
    wslDistroByPtyId: () => this.wslDistroByPtyId,
    titleObservationSequence: () => this.titleObservationSequence,
    setTitleObservationSequence: (sequence) => {
      this.titleObservationSequence = sequence
    },
    assertGraphReady: () => this.assertGraphReady(),
    getOrchestrationDb: () => this._orchestrationDb
  })

  protected readonly handles = this.terminalIdentity.handles

  protected readonly handleByLeafKey = this.terminalIdentity.handleByLeafKey

  protected readonly handleByPtyId = this.terminalIdentity.handleByPtyId

  protected readonly handleByPtyIncarnation = this.terminalIdentity.handleByPtyIncarnation

  // A provider announces a replacement before the spawn commit can bind its
  // pane. Keep the predecessor aliases fenced during that hand-off window.
  protected readonly pendingPtyHandleReplacementFences =
    this.terminalIdentity.pendingPtyHandleReplacementFences

  protected readonly mailPointerRepointScheduler = new MailPointerRepointScheduler((handle) =>
    this.repointPendingMessagesForHandle(handle)
  )

  protected readonly syntheticTerminalHandles = this.terminalIdentity.syntheticTerminalHandles

  protected readonly detachedPreAllocatedLeaves = this.terminalIdentity.detachedPreAllocatedLeaves

  protected readonly terminalWaiters = new RuntimeTerminalWaiterRegistry()

  protected readonly terminalWriter = new RuntimeTerminalWriter(
    (ptyId, data, inputKind) => this.ptyController?.write(ptyId, data, inputKind) ?? false,
    (ptyId) => this.getPtyWriteHostPlatform(ptyId),
    (ptyId) => this.getPtyAgent(ptyId),
    (ptyId, data, inputKind) =>
      this.ptyController?.writeWithSettlement?.(ptyId, data, inputKind) ??
      writeRefused('provider_cannot_settle')
  )

  // Why one source: every tui-idle site must read the same evidence, or they rank one pane differently.
  protected readonly tuiIdleEvidenceSource: TuiIdleEvidenceSource = {
    quiescenceMs: TUI_IDLE_QUIESCENCE_MS,
    getTabTitle: (tabId) => this.tabs.get(tabId)?.title ?? null,
    getAdoptedPtyIdleStatus: (pty) => this.getAdoptedPtyExplicitIdleStatus(pty),
    getPaneAgent: (ptyId) => this.getPaneAgentForTuiIdle(ptyId),
    getFirstPartyAgentStatus: (ptyId) =>
      (ptyId ? this.ptysById.get(ptyId)?.lastExplicitAgentStatus : null) ?? null,
    getHookTurn: (ptyId, agent) => this.readTuiIdleHookTurnForPty(ptyId, agent),
    readScreenLines: (ptyId) => this.readLiveTerminalScreenLines(ptyId),
    readRuledScreen: (ptyId) => this.readRuledScreen(ptyId),
    getTitleObservedAtEpochMs: (ptyId) =>
      (ptyId ? this.ptysById.get(ptyId)?.lastOscTitleEpochMs : null) ?? null
  }

  protected readonly terminalIdlePolls = createSessionTerminalIdlePolls(
    this.tuiIdleEvidenceSource,
    this.sessionPorts,
    // Why the runtime's own emulator: a provider snapshot would be a host round trip per tick.
    (ptyId) =>
      this.headlessTerminals.has(ptyId)
        ? this.readHeadlessVisibleTerminalState(ptyId).then(
            (screen) => screen?.lines.join('\n') ?? null
          )
        : null
  )

  protected readonly terminalWait = new RuntimeTerminalWaitController(
    {
      ...this.tuiIdleEvidenceSource,
      defaultTimeoutMs: TUI_IDLE_DEFAULT_TIMEOUT_MS,
      getLivePty: (handle) => this.getLivePtyForHandle(handle),
      getLiveLeaf: (handle) => this.getLiveLeafForHandle(handle),
      startVisibleReadProbe: (waiter, waiterTimeoutMs, agent) =>
        this.startTuiIdleVisibleReadProbe(waiter, waiterTimeoutMs, agent)
    },
    this.terminalWaiters,
    this.terminalIdlePolls
  )
}
