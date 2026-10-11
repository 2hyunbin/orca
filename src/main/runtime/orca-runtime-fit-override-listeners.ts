// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import {
  createTerminalOutputHost,
  type TerminalOutputHost
} from './terminal/output/terminal-output-host'
import { OrcaRuntimeWithStopRequestedPtyIds } from './orca-runtime-stop-requested-pty-ids'
import { RuntimeSubscriptionRegistry } from './runtime-subscription-registry'
import { RuntimeMobileNotificationController } from './runtime-mobile-notification-controller'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

import { RuntimeTerminalViewSubscribers } from './runtime-terminal-view-subscribers'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'

export class OrcaRuntimeWithFitOverrideListeners extends OrcaRuntimeWithStopRequestedPtyIds {
  // Why: mobile clients need to know when the desktop restores a terminal
  // from mobile-fit so they can update their UI. These listeners are
  // invoked from resizeForClient and onClientDisconnected/onPtyExit.
  protected fitOverrideListeners = new Map<
    string,
    Set<
      (event: {
        mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
        cols: number
        rows: number
      }) => void
    >
  >()

  protected readonly subscriptions = new RuntimeSubscriptionRegistry()

  protected readonly mobileNotifications = new RuntimeMobileNotificationController()

  protected ptysById = new Map<string, RuntimePtyWorktreeRecord>()

  protected readonly pairedRendererSessionOwnedPtyIds = new Set<string>()

  protected wslDistroByPtyId = new Map<string, string>()

  protected titleObservationSequence = 0

  protected readonly headlessTerminals = this.terminalOutput.headlessTerminals

  protected readonly ptyOutputSequenceById = this.terminalOutput.ptyOutputSequenceById

  protected readonly providerSequenceInitializedPtys =
    this.terminalOutput.providerSequenceInitializedPtys

  protected readonly providerSequenceOffsetByPtyId =
    this.terminalOutput.providerSequenceOffsetByPtyId

  protected readonly providerSnapshotPreferredPtys =
    this.terminalOutput.providerSnapshotPreferredPtys

  protected readonly providerModeTrackersByPtyId = this.terminalOutput.providerModeTrackersByPtyId

  protected readonly providerModeSnapshotScansByPtyId =
    this.terminalOutput.providerModeSnapshotScansByPtyId

  protected readonly providerBufferAcquisitionsByPtyId =
    this.terminalOutput.providerBufferAcquisitionsByPtyId

  protected readonly providerVisibleStateByPtyId = this.terminalOutput.providerVisibleStateByPtyId

  protected readonly providerVisibleStateReadsByPtyId =
    this.terminalOutput.providerVisibleStateReadsByPtyId

  protected readonly providerVisibleRetryAtByPtyId =
    this.terminalOutput.providerVisibleRetryAtByPtyId

  protected readonly providerSnapshotsWithLiveModeTransition =
    this.terminalOutput.providerSnapshotsWithLiveModeTransition

  protected readonly ptyLifecycleGenerationById = this.terminalOutput.ptyLifecycleGenerationById

  protected get nextPtyLifecycleGeneration() {
    return this.terminalOutput.nextPtyLifecycleGeneration
  }
  protected set nextPtyLifecycleGeneration(value: number) {
    this.terminalOutput.nextPtyLifecycleGeneration = value
  }

  protected readonly recentPtyPathCandidatesById = this.terminalOutput.recentPtyPathCandidatesById

  // Why: candidates only feed mobile file-tap provenance; desktop-only
  // sessions skip the 3-regex extraction on every PTY chunk until a
  // mobile/remote client authenticates (sticky, backfilled on activation).
  protected get recentPtyPathCandidateTrackingActive() {
    return this.terminalOutput.recentPtyPathCandidateTrackingActive
  }
  protected set recentPtyPathCandidateTrackingActive(value: boolean) {
    this.terminalOutput.recentPtyPathCandidateTrackingActive = value
  }

  // OSC 9999 status frames can span PTY chunks.
  protected readonly agentStatusOscProcessorsByPtyId =
    this.terminalOutput.agentStatusOscProcessorsByPtyId

  // Why: per-PTY shared title trackers (all-titles ordering + stale-working
  // timer) replace last-title-per-chunk scanning so main observes the same
  // intra-chunk working→idle transitions the renderer does (issue #1083).
  // Lazily created like agentStatusOscProcessorsByPtyId; disposed on PTY exit.
  protected readonly ptyTitleTrackersByPtyId = this.terminalOutput.ptyTitleTrackersByPtyId

  // Why: the Command Code output detector arms early from the launch command
  // when known (banner detection covers user-typed launches), mirroring the
  // renderer detector's startupCommand seed.
  protected readonly terminalSpawnCommandsByPtyId = this.terminalOutput.terminalSpawnCommandsByPtyId

  // Why: ordinary OSC 0/1/2 titles can split across PTY chunks, especially over
  // SSH/relay buffering. Keep a small raw scan tail and feed reconstructed
  // chunks into the title tracker instead of falling back to last-title scans.
  protected readonly oscTitleScanTailByPtyId = this.terminalOutput.oscTitleScanTailByPtyId

  // Why: mobile file taps resolve relative paths on the host. OSC 7 is the
  // terminal-owned cwd signal, and it can arrive in live output between snapshots.
  protected readonly osc7ScanTailByPtyId = this.terminalOutput.osc7ScanTailByPtyId

  protected readonly terminalCwdByPtyId = this.terminalOutput.terminalCwdByPtyId

  protected readonly terminalFileUriHostnameByPtyId =
    this.terminalOutput.terminalFileUriHostnameByPtyId

  // Why: per-PTY hydration state guards against double-hydration. Keys:
  //   'pending'  → maybeHydrateHeadlessFromRenderer is in flight
  //   'done'     → hydration completed (success or skip); never run again
  // Absent  → hydration has not been considered yet for this PTY.
  // See docs/mobile-prefer-renderer-scrollback.md.
  protected readonly headlessHydrationState = this.terminalOutput.headlessHydrationState

  // Why: mobile-fit overrides are keyed by ptyId (not terminal handle) because
  // handles can be reissued while the PTY identity is stable. In-memory only —
  // a stale phone override should not survive an app restart.
  protected terminalFitOverrides = new Map<
    string,
    {
      mode: 'mobile-fit'
      cols: number
      rows: number
      previousCols: number | null
      previousRows: number | null
      updatedAt: number
      clientId: string
    }
  >()

  // Why: server-authoritative display mode per terminal. 'auto' (default)
  // means phone-fit when mobile subscribes, desktop otherwise. 'desktop'
  // locks to no-resize regardless of subscriber state. The third historical
  // value ('phone' = sticky phone-fit after unsubscribe) was removed since
  // the toggle UI never produced it and nothing in product depended on it.
  // In-memory only — modes reset on restart.
  protected mobileDisplayModes = new Map<string, 'desktop'>()

  // Why: tracks active mobile subscribers per PTY so the runtime can restore
  // desktop dimensions on unsubscribe and prevent orphaned overrides during
  // rapid tab switches. Keyed by ptyId → inner map of clientId → subscriber.
  // The two-level map preserves multi-mobile soundness: phone B subscribing
  // does not silently overwrite phone A's record. See
  // docs/mobile-presence-lock.md "Multi-mobile subscriber model".
  // subscribedAt drives "earliest-by-subscribe-time" restore-target selection
  // (only among subscribers with non-null previousCols/Rows; desktop-mode
  // joins carry null and are skipped). lastActedAt drives "most-recent
  // actor's viewport wins" for active phone-fit dims.
  protected mobileSubscribers = new Map<
    string,
    Map<
      string,
      {
        clientId: string
        viewport: { cols: number; rows: number } | null
        wasResizedToPhone: boolean
        previousCols: number | null
        previousRows: number | null
        subscribedAt: number
        lastActedAt: number
      }
    >
  >()

  // Why: Phase-5 query-responder suppression — a terminal-RPC subscribe
  // stream feeds a remote xterm view (mobile/web/remote desktop) that answers
  // queries with view authority, so main must yield while one is attached
  // (terminal-query-authority.md). Ref-counted per PTY because multiple
  // streams can attach concurrently; mobileSubscribers is consulted too so
  // grace-window mobile records keep suppressing.
  protected readonly terminalViewSubscribers = new RuntimeTerminalViewSubscribers({
    notifyPresenceChanged: (ptyId) => this.notifyRemoteTerminalViewPresenceChanged(ptyId),
    hasMobileSubscribers: (ptyId) => (this.mobileSubscribers.get(ptyId)?.size ?? 0) > 0,
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
    },
    attachProvider: (ptyId) => {
      const attach = this.ptyController?.attach
      return attach ? (async () => attach(ptyId))() : null
    }
  })

  protected createTerminalOutputHost(): TerminalOutputHost {
    return createTerminalOutputHost({
      invokeClaudeTerminalEvidence: (...args) => this.onClaudeTerminalEvidence(...args),
      invokeTerminalAgentStatus: (...args) => this.onTerminalAgentStatus(...args),
      invokeTerminalSideEffects: (...args) => this.onTerminalSideEffects?.(...args),
      reconcileEndedProcess: (getPaneKeys) =>
        this.reconcileAgentStatusForEndedProcessFn?.(getPaneKeys()),
      scanProviderModeTrackers: (...args) => this.scanProviderModeTrackers(...args),
      recordOsc7MetadataForPty: (...args) => this.recordOsc7MetadataForPty(...args),
      processAgentStatusOscForPty: (...args) => this.processAgentStatusOscForPty(...args),
      recordRecentPtyOutputForPathProvenance: (...args) =>
        this.recordRecentPtyOutputForPathProvenance(...args),
      shouldAnswerQueriesForLiveChunk: (...args) => this.shouldAnswerQueriesForLiveChunk(...args),
      maybeHydrateHeadlessFromRenderer: (...args) => this.maybeHydrateHeadlessFromRenderer(...args),
      trackHeadlessTerminalData: (...args) => this.trackHeadlessTerminalData(...args),
      getOrCreatePtyTitleTrackerEntry: (...args) => this.getOrCreatePtyTitleTrackerEntry(...args),
      emitTerminalAgentStatusEvents: (...args) => this.emitTerminalAgentStatusEvents(...args),
      flushPendingTerminalSideEffectFacts: (...args) =>
        this.flushPendingTerminalSideEffectFacts(...args),
      pathFlavorForPty: (...args) => this.pathFlavorForPty(...args),
      getPtyLifecycleGeneration: (...args) => this.getPtyLifecycleGeneration(...args),
      getTerminalSize: (...args) => this.getTerminalSize(...args),
      createPtyHeadlessTerminalState: (...args) => this.createPtyHeadlessTerminalState(...args),
      disposeHeadlessTerminal: (...args) => this.disposeHeadlessTerminal(...args),
      serializeProviderTerminalBuffer: (...args) => this.serializeProviderTerminalBuffer(...args),
      resizeHeadlessTerminal: (...args) => this.resizeHeadlessTerminal(...args),
      getPtyOutputSequence: (...args) => this.getPtyOutputSequence(...args),
      getTrackedRawTitleForPty: (...args) => this.getTrackedRawTitleForPty(...args),
      applySeededAgentStatus: (...args) => this.applySeededAgentStatus(...args),
      getOrCreateHeadlessTerminal: (...args) => this.getOrCreateHeadlessTerminal(...args),
      serializeHeadlessTerminalBuffer: (...args) => this.serializeHeadlessTerminalBuffer(...args),
      serializePreferredRestoredTerminalBuffer: (...args) =>
        this.serializePreferredRestoredTerminalBuffer(...args),
      serializeRendererTerminalBuffer: (...args) => this.serializeRendererTerminalBuffer(...args),
      preferTrackedLastTitle: (...args) => this.preferTrackedLastTitle(...args),
      captureProviderTerminalBuffer: (...args) => this.captureProviderTerminalBuffer(...args),
      readProviderTerminalTailLines: (...args) => this.readProviderTerminalTailLines(...args),
      isTerminalAlternateScreen: (...args) => this.isTerminalAlternateScreen(...args),
      readVisibleTerminalState: (...args) => this.readVisibleTerminalState(...args),
      readRendererVisibleSnapshotLines: (...args) => this.readRendererVisibleSnapshotLines(...args),
      parseVisibleSnapshot: (...args) => this.parseVisibleSnapshot(...args),
      loadVisibleTerminalState: (...args) => this.loadVisibleTerminalState(...args),
      readHeadlessVisibleTerminalState: (...args) => this.readHeadlessVisibleTerminalState(...args),
      readWholeScreenModel: (...args) => this.readWholeScreenModel(...args),
      clearHeadlessTerminalBuffer: (...args) => this.clearHeadlessTerminalBuffer(...args),
      resetHeadlessTerminalInputModes: (...args) => this.resetHeadlessTerminalInputModes(...args),
      emitTerminalSideEffectBatch: (...args) => this.emitTerminalSideEffectBatch(...args),
      recordTerminalSideEffectFact: (...args) => this.recordTerminalSideEffectFact(...args),
      resolveTerminalSideEffectAttribution: (...args) =>
        this.resolveTerminalSideEffectAttribution(...args),
      getPtyTitleDisplayClear: (...args) => this.getPtyTitleDisplayClear(...args),
      getTrackedDisplayTitleForPty: (...args) => this.getTrackedDisplayTitleForPty(...args),
      makeDecorativeTitleGateKey: (...args) => this.makeDecorativeTitleGateKey(...args),
      applyTrackedPtyTitle: (...args) => this.applyTrackedPtyTitle(...args),
      isLiveCursorNativeTitle: (...args) => this.isLiveCursorNativeTitle(...args),
      createTerminalSideEffectCommandCodeDetector: (...args) =>
        this.createTerminalSideEffectCommandCodeDetector(...args),
      observeClaudeTerminalEvidence: (...args) => this.observeClaudeTerminalEvidence(...args),
      disposePtyTitleTracker: (...args) => this.disposePtyTitleTracker(...args),
      refreshTerminalSideEffectConsumerAvailability: (...args) =>
        this.refreshTerminalSideEffectConsumerAvailability(...args),
      extractLastOsc7CwdForPty: (...args) => this.extractLastOsc7CwdForPty(...args),
      activateRecentPtyPathCandidateTracking: (...args) =>
        this.activateRecentPtyPathCandidateTracking(...args),
      advancePtyLifecycleGeneration: (...args) => this.advancePtyLifecycleGeneration(...args),
      resetTrackedTerminalStateForProviderGeneration: (...args) =>
        this.resetTrackedTerminalStateForProviderGeneration(...args),
      agentPromptExplicitStatusFloorByPtyId: () => this.agentPromptExplicitStatusFloorByPtyId,
      agentPromptLifecycleByPtyId: () => this.agentPromptLifecycleByPtyId,
      agentPromptPermissionSequenceByPtyId: () => this.agentPromptPermissionSequenceByPtyId,
      clientEvents: () => this.clientEvents,
      legacyWorkerRecovery: () => this.legacyWorkerRecovery,
      mobileSessionTabListeners: () => this.mobileSessionTabListeners,
      mobileSessionTabsAgentStatusHeartbeat: () => this.mobileSessionTabsAgentStatusHeartbeat,
      onClaudeTerminalEvidence: () => this.onClaudeTerminalEvidence,
      onTerminalAgentStatus: () => this.onTerminalAgentStatus,
      onTerminalSideEffects: () => this.onTerminalSideEffects,
      openCodeRunLifetime: () => this.openCodeRunLifetime,
      orchestrationMailboxPointerDelivery: () => this.orchestrationMailboxPointerDelivery,
      ptyController: () => this.ptyController,
      ptyForegroundAgent: () => this.ptyForegroundAgent,
      ptysById: () => this.ptysById,
      reconcileAgentStatusForEndedProcessFn: () => this.reconcileAgentStatusForEndedProcessFn,
      store: () => this.store,
      terminalStreamConsumers: () => this.terminalStreamConsumers,
      terminalViewSubscribers: () => this.terminalViewSubscribers,
      stopRequestedPtyIds: () => this.stopRequestedPtyIds,
      wslDistroByPtyId: () => this.wslDistroByPtyId,
      graphSequence: () => this.graphSequence,
      graphStatus: () => this.graphStatus,
      scheduleWaitBlockedCheck: (ptyId, data, at) => this.scheduleWaitBlockedCheck(ptyId, data, at),
      primeWaitBlockedBaselineFromSeededTail: (ptyId) =>
        this.primeWaitBlockedBaselineFromSeededTail(ptyId),
      clearWaitBlockedCheckState: (ptyId) => this.clearWaitBlockedCheckState(ptyId),
      checkDeliverySettledAndArmRecheck: (...args) =>
        this.checkDeliverySettledAndArmRecheck(...args),
      clearAgentPromptCorrelationForPty: (...args) =>
        this.clearAgentPromptCorrelationForPty(...args),
      collectAgentStatusPaneKeysForPty: (...args) => this.collectAgentStatusPaneKeysForPty(...args),
      collectPaneKeysForPty: (...args) => this.collectPaneKeysForPty(...args),
      confirmPtyAgentExit: (...args) => this.confirmPtyAgentExit(...args),
      countTerminalSideEffectConsumingClientEventListeners: (...args) =>
        this.countTerminalSideEffectConsumingClientEventListeners(...args),
      delayPtyBackedMobileSnapshotForForegroundAgent: (...args) =>
        this.delayPtyBackedMobileSnapshotForForegroundAgent(...args),
      deliverPendingMessagesForLeaf: (...args) => this.deliverPendingMessagesForLeaf(...args),
      emitClientEvent: (...args) => this.emitClientEvent(...args),
      getAgentStatusTerminalHandleForPaneKey: (...args) =>
        this.getAgentStatusTerminalHandleForPaneKey(...args),
      getLeavesForPty: (...args) => this.getLeavesForPty(...args),
      getOrCreatePtyWorktreeRecord: (...args) => this.getOrCreatePtyWorktreeRecord(...args),
      getPendingForegroundAgentRefreshForTitle: (...args) =>
        this.getPendingForegroundAgentRefreshForTitle(...args),
      hasRemoteTerminalViewSubscriber: (...args) => this.hasRemoteTerminalViewSubscriber(...args),
      isKnownUnattachedLocalDaemonPty: (...args) => this.isKnownUnattachedLocalDaemonPty(...args),
      makeRuntimePaneKey: (...args) => this.makeRuntimePaneKey(...args),
      nextTitleObservationSequence: (...args) => this.nextTitleObservationSequence(...args),
      recheckHookAgentPresenceForPty: (...args) => this.recheckHookAgentPresenceForPty(...args),
      recordAgentPromptLifecycleState: (...args) => this.recordAgentPromptLifecycleState(...args),
      recordPtyWorktree: (...args) => this.recordPtyWorktree(...args),
      resolveLeafForHandle: (...args) => this.resolveLeafForHandle(...args),
      resolvePtyTuiIdleWaiters: (...args) => this.resolvePtyTuiIdleWaiters(...args),
      resolveTuiIdleWaiters: (...args) => this.resolveTuiIdleWaiters(...args),
      restoreAgentPromptLifecycleByteOrder: (...args) =>
        this.restoreAgentPromptLifecycleByteOrder(...args),
      retirePtyAgentLaunchAuthority: (...args) => this.retirePtyAgentLaunchAuthority(...args),
      setPtyManagementTitleFromObservedTitle: (...args) =>
        this.setPtyManagementTitleFromObservedTitle(...args),
      shouldDelayPtyBackedMobileSnapshotForForegroundAgent: (...args) =>
        this.shouldDelayPtyBackedMobileSnapshotForForegroundAgent(...args),
      touchMobileSessionSnapshotsForPty: (...args) =>
        this.touchMobileSessionSnapshotsForPty(...args)
    })
  }
}
