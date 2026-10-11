import type {
  ProviderBufferAcquisition,
  RuntimeHeadlessTerminal,
  RuntimePtyTitleTrackerEntry,
  RuntimeVisibleTerminalState
} from '../../runtime-terminal-state-records'
import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import type { PtyProviderBufferSnapshot } from '../../../providers/types'
import type { createAgentStatusOscProcessor } from '../../../../shared/agent-status-osc'

import type { RecentPtyOutputBuffer } from '../../recent-pty-output-buffer'

import type { TerminalOutputHost } from './terminal-output-host'
import * as ptyOutputIngestion from './pty-output-ingestion'
import * as headlessTerminalCreate from './headless-terminal-create'
import * as headlessTerminalControls from './headless-terminal-controls'
import * as headlessTerminalHydration from './headless-terminal-hydration'
import * as headlessTerminalWriteChain from './headless-terminal-write-chain'
import * as headlessTerminalSeed from './headless-terminal-seed'
import * as terminalBufferSelection from './terminal-buffer-selection'
import * as rendererBufferSnapshot from './renderer-buffer-snapshot'
import * as providerBufferSnapshot from './provider-buffer-snapshot'
import * as terminalSnapshotTailProjection from './terminal-snapshot-tail-projection'
import * as terminalVisibleState from './terminal-visible-state'
import * as headlessBufferSnapshot from './headless-buffer-snapshot'
import * as terminalBufferControls from './terminal-buffer-controls'
import * as terminalAgentStatusOsc from './terminal-agent-status-osc'
import * as terminalTransientFacts from './terminal-transient-facts'
import * as terminalTitleDisplay from './terminal-title-display'
import * as terminalTitleTracker from './terminal-title-tracker'
import * as terminalTitleObservation from './terminal-title-observation'
import * as terminalTitleLifetime from './terminal-title-lifetime'
import * as terminalOscMetadata from './terminal-osc-metadata'
import * as terminalDerivedAgentFacts from './terminal-derived-agent-facts'
import * as terminalOutputProvenance from './terminal-output-provenance'
import * as terminalOutputGeneration from './terminal-output-generation'

export class RuntimeTerminalOutputOwner {
  readonly headlessTerminals = new Map<string, RuntimeHeadlessTerminal>()

  readonly ptyOutputSequenceById = new Map<string, number>()

  readonly providerSequenceInitializedPtys = new Set<string>()

  readonly providerSequenceOffsetByPtyId = new Map<string, number>()

  readonly providerSnapshotPreferredPtys = new Set<string>()

  readonly providerModeTrackersByPtyId = new Map<string, TerminalKittyKeyboardModeTracker>()

  readonly providerModeSnapshotScansByPtyId = new Map<
    string,
    Set<TerminalKittyKeyboardModeTracker>
  >()

  readonly providerBufferAcquisitionsByPtyId = new Map<string, ProviderBufferAcquisition>()

  readonly providerVisibleStateByPtyId = new Map<string, RuntimeVisibleTerminalState>()

  readonly providerVisibleStateReadsByPtyId = new Map<
    string,
    { generation: number; promise: Promise<RuntimeVisibleTerminalState | null> }
  >()

  readonly providerVisibleRetryAtByPtyId = new Map<string, number>()

  readonly providerSnapshotsWithLiveModeTransition = new WeakSet<PtyProviderBufferSnapshot>()

  readonly ptyLifecycleGenerationById = new Map<string, number>()

  nextPtyLifecycleGeneration = 1

  readonly recentPtyPathCandidatesById = new Map<string, string[]>()

  recentPtyPathCandidateTrackingActive = false

  readonly agentStatusOscProcessorsByPtyId = new Map<
    string,
    ReturnType<typeof createAgentStatusOscProcessor>
  >()

  readonly ptyTitleTrackersByPtyId = new Map<string, RuntimePtyTitleTrackerEntry>()

  readonly terminalSpawnCommandsByPtyId = new Map<string, string>()

  readonly oscTitleScanTailByPtyId = new Map<string, string>()

  readonly osc7ScanTailByPtyId = new Map<string, string>()

  readonly terminalCwdByPtyId = new Map<string, string>()

  readonly terminalFileUriHostnameByPtyId = new Map<string, string>()

  readonly headlessHydrationState = new Map<string, 'pending' | 'done'>()

  readonly recentPtyOutputById = new Map<string, RecentPtyOutputBuffer>()

  terminalSideEffectLocalConsumerAvailable = false

  terminalSideEffectConsumerAvailable = false

  constructor(readonly host: TerminalOutputHost) {}

  readonly scanProviderModeTrackers = ptyOutputIngestion.scanProviderModeTrackers.bind(
    undefined,
    this
  )

  readonly onPtyData = ptyOutputIngestion.onPtyData.bind(undefined, this)

  readonly createPtyHeadlessTerminalState =
    headlessTerminalCreate.createPtyHeadlessTerminalState.bind(undefined, this)

  readonly ensureNativeWindowsConptyDa1Override =
    headlessTerminalCreate.ensureNativeWindowsConptyDa1Override.bind(undefined, this)

  readonly getOrCreateHeadlessTerminal = headlessTerminalCreate.getOrCreateHeadlessTerminal.bind(
    undefined,
    this
  )

  readonly replaceHeadlessTerminalAfterExecutionContextChange =
    headlessTerminalCreate.replaceHeadlessTerminalAfterExecutionContextChange.bind(undefined, this)

  readonly resizeHeadlessTerminal = headlessTerminalControls.resizeHeadlessTerminal.bind(
    undefined,
    this
  )

  readonly reflowHeadlessTerminalToPtyGrid =
    headlessTerminalControls.reflowHeadlessTerminalToPtyGrid.bind(undefined, this)

  readonly clearHeadlessTerminalBuffer = headlessTerminalControls.clearHeadlessTerminalBuffer.bind(
    undefined,
    this
  )

  readonly resetHeadlessTerminalInputModes =
    headlessTerminalControls.resetHeadlessTerminalInputModes.bind(undefined, this)

  readonly maybeHydrateHeadlessFromRenderer =
    headlessTerminalHydration.maybeHydrateHeadlessFromRenderer.bind(undefined, this)

  readonly applySeededAgentStatus = headlessTerminalHydration.applySeededAgentStatus.bind(
    undefined,
    this
  )

  readonly shouldAnswerQueriesForLiveChunk =
    headlessTerminalHydration.shouldAnswerQueriesForLiveChunk.bind(undefined, this)

  readonly trackHeadlessTerminalData = headlessTerminalWriteChain.trackHeadlessTerminalData.bind(
    undefined,
    this
  )

  readonly seedHeadlessTerminal = headlessTerminalSeed.seedHeadlessTerminal.bind(undefined, this)

  readonly seedTerminalRestoreTail = headlessTerminalSeed.seedTerminalRestoreTail.bind(
    undefined,
    this
  )

  readonly serializeMainTerminalBuffer = terminalBufferSelection.serializeMainTerminalBuffer.bind(
    undefined,
    this
  )

  readonly serializeHiddenOutputRecoveryBuffer =
    terminalBufferSelection.serializeHiddenOutputRecoveryBuffer.bind(undefined, this)

  readonly serializeTerminalBufferFromAvailableState =
    terminalBufferSelection.serializeTerminalBufferFromAvailableState.bind(undefined, this)

  readonly serializePreferredRestoredTerminalBuffer =
    terminalBufferSelection.serializePreferredRestoredTerminalBuffer.bind(undefined, this)

  readonly serializeRendererTerminalBuffer =
    rendererBufferSnapshot.serializeRendererTerminalBuffer.bind(undefined, this)

  readonly serializeProviderTerminalBuffer =
    providerBufferSnapshot.serializeProviderTerminalBuffer.bind(undefined, this)

  readonly captureProviderTerminalBuffer =
    providerBufferSnapshot.captureProviderTerminalBuffer.bind(undefined, this)

  readonly withVisibleSnapshotFallback =
    terminalSnapshotTailProjection.withVisibleSnapshotFallback.bind(undefined, this)

  readonly readProviderTerminalTailLines =
    terminalSnapshotTailProjection.readProviderTerminalTailLines.bind(undefined, this)

  readonly parseVisibleSnapshot = terminalSnapshotTailProjection.parseVisibleSnapshot

  readonly readRendererVisibleSnapshotLines =
    terminalSnapshotTailProjection.readRendererVisibleSnapshotLines.bind(undefined, this)

  readonly visibleSnapshotPreview = terminalVisibleState.visibleSnapshotPreview.bind(
    undefined,
    this
  )

  readonly readVisibleTerminalState = terminalVisibleState.readVisibleTerminalState.bind(
    undefined,
    this
  )

  readonly loadVisibleTerminalState = terminalVisibleState.loadVisibleTerminalState.bind(
    undefined,
    this
  )

  readonly readHeadlessVisibleTerminalState =
    terminalVisibleState.readHeadlessVisibleTerminalState.bind(undefined, this)

  readonly readLiveTerminalScreenLines = terminalVisibleState.readLiveTerminalScreenLines.bind(
    undefined,
    this
  )

  readonly readRuledScreen = terminalVisibleState.readRuledScreen.bind(undefined, this)

  readonly readWholeScreenModel = terminalVisibleState.readWholeScreenModel.bind(undefined, this)

  readonly serializeHeadlessTerminalBuffer =
    headlessBufferSnapshot.serializeHeadlessTerminalBuffer.bind(undefined, this)

  readonly disposeHeadlessTerminal = headlessBufferSnapshot.disposeHeadlessTerminal.bind(
    undefined,
    this
  )

  readonly clearTerminalBuffer = terminalBufferControls.clearTerminalBuffer.bind(undefined, this)

  readonly resetTerminalInputModes = terminalBufferControls.resetTerminalInputModes.bind(
    undefined,
    this
  )

  readonly getTerminalSize = terminalBufferControls.getTerminalSize.bind(undefined, this)

  readonly isTerminalAlternateScreen = terminalBufferControls.isTerminalAlternateScreen.bind(
    undefined,
    this
  )

  readonly processAgentStatusOscForPty = terminalAgentStatusOsc.processAgentStatusOscForPty.bind(
    undefined,
    this
  )

  readonly flushPendingTerminalSideEffectFacts =
    terminalTransientFacts.flushPendingTerminalSideEffectFacts.bind(undefined, this)

  readonly runAfterPendingTerminalSideEffectFacts =
    terminalTransientFacts.runAfterPendingTerminalSideEffectFacts.bind(undefined, this)

  readonly ingestSyntheticTitleFrame = terminalTransientFacts.ingestSyntheticTitleFrame.bind(
    undefined,
    this
  )

  readonly setPtyTransientFactDelegation =
    terminalTransientFacts.setPtyTransientFactDelegation.bind(undefined, this)

  readonly emitDaemonPtyTransientFact = terminalTransientFacts.emitDaemonPtyTransientFact.bind(
    undefined,
    this
  )

  readonly notePtyDataGap = terminalTransientFacts.notePtyDataGap.bind(undefined, this)

  readonly recordTerminalSideEffectFact = terminalTransientFacts.recordTerminalSideEffectFact.bind(
    undefined,
    this
  )

  readonly emitTerminalSideEffectBatch = terminalTransientFacts.emitTerminalSideEffectBatch.bind(
    undefined,
    this
  )

  readonly resolveTerminalSideEffectAttribution =
    terminalTitleDisplay.resolveTerminalSideEffectAttribution.bind(undefined, this)

  readonly getTerminalSideEffectSnapshot = terminalTitleDisplay.getTerminalSideEffectSnapshot.bind(
    undefined,
    this
  )

  readonly getTrackedRawTitleForPty = terminalTitleDisplay.getTrackedRawTitleForPty.bind(
    undefined,
    this
  )

  readonly isLiveCursorNativeTitle = terminalTitleDisplay.isLiveCursorNativeTitle

  readonly getTrackedDisplayTitleForPty = terminalTitleDisplay.getTrackedDisplayTitleForPty.bind(
    undefined,
    this
  )

  readonly getPtyTitleDisplayClear = terminalTitleDisplay.getPtyTitleDisplayClear.bind(
    undefined,
    this
  )

  readonly getPtyDisplayRecord = terminalTitleDisplay.getPtyDisplayRecord.bind(undefined, this)

  readonly getLeafDisplayRecord = terminalTitleDisplay.getLeafDisplayRecord.bind(undefined, this)

  readonly getUnpersistedTrackedTitleForPty =
    terminalTitleDisplay.getUnpersistedTrackedTitleForPty.bind(undefined, this)

  preferTrackedLastTitle<T extends { lastTitle?: string }>(ptyId: string, snapshot: T): T {
    return terminalTitleDisplay.preferTrackedLastTitle(this, ptyId, snapshot)
  }

  readonly makeDecorativeTitleGateKey = terminalTitleDisplay.makeDecorativeTitleGateKey

  readonly getOrCreatePtyTitleTrackerEntry =
    terminalTitleTracker.getOrCreatePtyTitleTrackerEntry.bind(undefined, this)

  readonly observeClaudeTerminalEvidence =
    terminalTitleObservation.observeClaudeTerminalEvidence.bind(undefined, this)

  readonly applyTrackedPtyTitle = terminalTitleObservation.applyTrackedPtyTitle.bind(
    undefined,
    this
  )

  readonly applyStaleWorkingTitleClear = terminalTitleObservation.applyStaleWorkingTitleClear.bind(
    undefined,
    this
  )

  readonly disposePtyTitleTracker = terminalTitleLifetime.disposePtyTitleTracker.bind(
    undefined,
    this
  )

  readonly resetTrackedTerminalStateForProviderGeneration =
    terminalTitleLifetime.resetTrackedTerminalStateForProviderGeneration.bind(undefined, this)

  readonly setTerminalSideEffectConsumerAvailable =
    terminalTitleLifetime.setTerminalSideEffectConsumerAvailable.bind(undefined, this)

  readonly refreshTerminalSideEffectConsumerAvailability =
    terminalTitleLifetime.refreshTerminalSideEffectConsumerAvailability.bind(undefined, this)

  readonly extractLastOsc7CwdForPty = terminalOscMetadata.extractLastOsc7CwdForPty.bind(
    undefined,
    this
  )

  readonly recordOsc7MetadataForPty = terminalOscMetadata.recordOsc7MetadataForPty.bind(
    undefined,
    this
  )

  readonly pathFlavorForPty = terminalOscMetadata.pathFlavorForPty

  readonly createTerminalSideEffectCommandCodeDetector =
    terminalDerivedAgentFacts.createTerminalSideEffectCommandCodeDetector.bind(undefined, this)

  readonly emitTerminalAgentStatusEvents =
    terminalDerivedAgentFacts.emitTerminalAgentStatusEvents.bind(undefined, this)

  readonly recordRecentPtyOutputForPathProvenance =
    terminalOutputProvenance.recordRecentPtyOutputForPathProvenance.bind(undefined, this)

  readonly activateRecentPtyPathCandidateTracking =
    terminalOutputProvenance.activateRecentPtyPathCandidateTracking.bind(undefined, this)

  readonly hasRecentTerminalOutputPath = terminalOutputProvenance.hasRecentTerminalOutputPath.bind(
    undefined,
    this
  )

  readonly getPtyOutputSequence = terminalOutputGeneration.getPtyOutputSequence.bind(
    undefined,
    this
  )

  readonly getPtyLifecycleGeneration = terminalOutputGeneration.getPtyLifecycleGeneration.bind(
    undefined,
    this
  )

  readonly advancePtyLifecycleGeneration =
    terminalOutputGeneration.advancePtyLifecycleGeneration.bind(undefined, this)

  readonly synchronizePtyOutputSequenceFromProvider =
    terminalOutputGeneration.synchronizePtyOutputSequenceFromProvider.bind(undefined, this)
}
