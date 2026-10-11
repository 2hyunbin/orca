import type { TerminalOutputRuntimeReentry } from './terminal-output-runtime-reentry'
import type { RuntimeMessageWaiter } from '../../runtime-message-waiters'
import type { AgentStatus } from '../../../../shared/agent-detection'
import type { ClaudeTerminalEvidence } from '../../../../shared/claude-terminal-interrupt'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import type { RuntimeGraphStatus } from '../../../../shared/runtime-types'
import type { TerminalSideEffectBatch } from '../../../../shared/terminal-side-effect-facts'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'
import type { RuntimeStore } from '../../runtime-store-contract'
import type { RuntimeTerminalAgentStatusEvent } from '../../runtime-terminal-contracts'
import type { RuntimeClientEventBus } from '../../runtime-client-event-bus'
import type { RuntimeLegacyWorkerTerminalRecoveryController } from '../../runtime-legacy-worker-terminal-recovery-controller'
import type { MobileSessionTabsAgentStatusHeartbeat } from '../../mobile-session-tabs-agent-status-heartbeat'
import type { OpenCodeRunLifetimeStatus } from '../../opencode-run-lifetime-status'
import type { OrchestrationMailboxPointerDelivery } from '../../orchestration/mailbox-pointer-delivery'
import type { RuntimePtyForegroundAgent } from '../../runtime-pty-foreground-agent'
import type { RuntimeTerminalStreamConsumers } from '../../runtime-terminal-stream-consumers'

export type TerminalOutputHost = TerminalOutputRuntimeReentry & {
  readonly agentPromptExplicitStatusFloorByPtyId: Map<string, number>
  readonly agentPromptLifecycleByPtyId: Map<
    string,
    { status: AgentStatus | null; workingSequence: number; updatedAt: number }
  >
  readonly agentPromptPermissionSequenceByPtyId: Map<string, number>
  readonly clientEvents: Pick<RuntimeClientEventBus, 'clearPtyTitleGate'>
  readonly legacyWorkerRecovery: Pick<
    RuntimeLegacyWorkerTerminalRecoveryController,
    'hasRecoveredPty' | 'deleteRecoveredPty'
  >
  readonly mobileSessionTabListeners: { readonly size: number }
  readonly mobileSessionTabsAgentStatusHeartbeat: Pick<
    MobileSessionTabsAgentStatusHeartbeat,
    'removePty' | 'observeSemanticTitle' | 'scheduleDecorativeHeartbeat'
  >
  readonly onClaudeTerminalEvidence:
    | ((paneKey: string, evidence: ClaudeTerminalEvidence) => void)
    | null
  readonly onTerminalAgentStatus: ((event: RuntimeTerminalAgentStatusEvent) => void) | null
  readonly onTerminalSideEffects: ((batch: TerminalSideEffectBatch) => void) | null
  readonly openCodeRunLifetime: Pick<
    OpenCodeRunLifetimeStatus,
    'onCommandStarted' | 'onCommandFinished' | 'forgetPty'
  >
  readonly orchestrationMailboxPointerDelivery: Pick<
    OrchestrationMailboxPointerDelivery<RuntimeMessageWaiter>,
    'observeAgentWorking' | 'observeAgentIdle'
  >
  readonly ptyController: Pick<
    RuntimePtyController,
    | 'serializeBuffer'
    | 'hasRendererSerializer'
    | 'write'
    | 'confirmShellForeground'
    | 'getSize'
    | 'clearBuffer'
    | 'resetInputModes'
    | 'serializeProviderBuffer'
  > | null
  readonly ptyForegroundAgent: Pick<
    RuntimePtyForegroundAgent,
    'refresh' | 'hasDelayedSnapshot' | 'clearDelayedSnapshot'
  >
  readonly ptysById: Map<string, RuntimePtyWorktreeRecord>
  readonly reconcileAgentStatusForEndedProcessFn: ((paneKeys: Iterable<string>) => void) | null
  readonly store: Pick<RuntimeStore, 'getSettings'> | null
  readonly terminalStreamConsumers: Pick<RuntimeTerminalStreamConsumers, 'publish'>
  resetTerminalViewGeneration(ptyId: string): void
  readonly stopRequestedPtyIds: Set<string>
  readonly wslDistroByPtyId: Map<string, string>
  readonly graphSequence: number
  readonly graphStatus: RuntimeGraphStatus
  invokeClaudeTerminalEvidence: NonNullable<TerminalOutputHost['onClaudeTerminalEvidence']>
  invokeTerminalAgentStatus: NonNullable<TerminalOutputHost['onTerminalAgentStatus']>
  invokeTerminalSideEffects: NonNullable<TerminalOutputHost['onTerminalSideEffects']>
  reconcileEndedProcess(getPaneKeys: () => Iterable<string>): void
  scheduleWaitBlockedCheck(ptyId: string, appendedText: string, at: number): void
  primeWaitBlockedBaselineFromSeededTail(ptyId: string): void
  clearWaitBlockedCheckState(ptyId: string): void
  checkDeliverySettledAndArmRecheck(leaf: RuntimeLeafRecord): boolean
  clearAgentPromptCorrelationForPty(ptyId: string): void
  collectAgentStatusPaneKeysForPty(ptyId: string): Set<string>
  collectPaneKeysForPty(ptyId: string): Set<string>
  confirmPtyAgentExit(ptyId: string, recoverCompletedHook?: boolean): void
  countTerminalSideEffectConsumingClientEventListeners(): number
  delayPtyBackedMobileSnapshotForForegroundAgent(
    ptyId: string,
    observedAt: number,
    refresh: Promise<boolean>
  ): void
  deliverPendingMessagesForLeaf(leaf: RuntimeLeafRecord): void
  emitClientEvent(event: RuntimeClientEvent): void
  getAgentStatusTerminalHandleForPaneKey(paneKey: string): string | null
  getLeavesForPty(ptyId: string): RuntimeLeafRecord[]
  getOrCreatePtyWorktreeRecord(ptyId: string): RuntimePtyWorktreeRecord | null
  getPendingForegroundAgentRefreshForTitle(
    ptyId: string,
    observedAt: number
  ): Promise<boolean> | undefined
  hasRemoteTerminalViewSubscriber(ptyId: string): boolean
  isKnownUnattachedLocalDaemonPty(ptyId: string): boolean
  makeRuntimePaneKey(leaf: RuntimeLeafRecord): string
  nextTitleObservationSequence(): number
  recheckHookAgentPresenceForPty(ptyId: string): void
  recordAgentPromptLifecycleState(ptyId: string, status: AgentStatus | null): void
  recordPtyWorktree(
    ptyId: string,
    worktreeId: string,
    state: Partial<
      Pick<
        RuntimePtyWorktreeRecord,
        | 'connected'
        | 'lastOutputAt'
        | 'preview'
        | 'tabId'
        | 'paneKey'
        | 'surfaceRecordedAtGraphSequence'
      >
    >
  ): RuntimePtyWorktreeRecord
  resolveLeafForHandle(handle: string): { ptyId: string | null } | null
  resolvePtyTuiIdleWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void
  resolveTuiIdleWaiters(leaf: RuntimeLeafRecord): void
  restoreAgentPromptLifecycleByteOrder(
    ptyId: string,
    titleInput: string,
    titleOffset: number | null
  ): void
  retirePtyAgentLaunchAuthority(ptyId: string): void
  setPtyManagementTitleFromObservedTitle(
    pty: RuntimePtyWorktreeRecord,
    title: string | null | undefined,
    observedAt: number
  ): void
  shouldDelayPtyBackedMobileSnapshotForForegroundAgent(
    pty: RuntimePtyWorktreeRecord,
    title: string
  ): boolean
  touchMobileSessionSnapshotsForPty(ptyId: string): void
}

type LazyHostField =
  | 'agentPromptExplicitStatusFloorByPtyId'
  | 'agentPromptLifecycleByPtyId'
  | 'agentPromptPermissionSequenceByPtyId'
  | 'clientEvents'
  | 'legacyWorkerRecovery'
  | 'mobileSessionTabListeners'
  | 'mobileSessionTabsAgentStatusHeartbeat'
  | 'onClaudeTerminalEvidence'
  | 'onTerminalAgentStatus'
  | 'onTerminalSideEffects'
  | 'openCodeRunLifetime'
  | 'orchestrationMailboxPointerDelivery'
  | 'ptyController'
  | 'ptyForegroundAgent'
  | 'ptysById'
  | 'reconcileAgentStatusForEndedProcessFn'
  | 'store'
  | 'terminalStreamConsumers'
  | 'stopRequestedPtyIds'
  | 'wslDistroByPtyId'
  | 'graphSequence'
  | 'graphStatus'

export type TerminalOutputDependencies = {
  [Key in keyof TerminalOutputHost]: Key extends LazyHostField
    ? () => TerminalOutputHost[Key]
    : TerminalOutputHost[Key]
}

export function createTerminalOutputHost(
  dependencies: TerminalOutputDependencies
): TerminalOutputHost {
  return {
    ...dependencies,
    get agentPromptExplicitStatusFloorByPtyId() {
      return dependencies.agentPromptExplicitStatusFloorByPtyId()
    },
    get agentPromptLifecycleByPtyId() {
      return dependencies.agentPromptLifecycleByPtyId()
    },
    get agentPromptPermissionSequenceByPtyId() {
      return dependencies.agentPromptPermissionSequenceByPtyId()
    },
    get clientEvents() {
      return dependencies.clientEvents()
    },
    get legacyWorkerRecovery() {
      return dependencies.legacyWorkerRecovery()
    },
    get mobileSessionTabListeners() {
      return dependencies.mobileSessionTabListeners()
    },
    get mobileSessionTabsAgentStatusHeartbeat() {
      return dependencies.mobileSessionTabsAgentStatusHeartbeat()
    },
    get onClaudeTerminalEvidence() {
      return dependencies.onClaudeTerminalEvidence()
    },
    get onTerminalAgentStatus() {
      return dependencies.onTerminalAgentStatus()
    },
    get onTerminalSideEffects() {
      return dependencies.onTerminalSideEffects()
    },
    get openCodeRunLifetime() {
      return dependencies.openCodeRunLifetime()
    },
    get orchestrationMailboxPointerDelivery() {
      return dependencies.orchestrationMailboxPointerDelivery()
    },
    get ptyController() {
      return dependencies.ptyController()
    },
    get ptyForegroundAgent() {
      return dependencies.ptyForegroundAgent()
    },
    get ptysById() {
      return dependencies.ptysById()
    },
    get reconcileAgentStatusForEndedProcessFn() {
      return dependencies.reconcileAgentStatusForEndedProcessFn()
    },
    get store() {
      return dependencies.store()
    },
    get terminalStreamConsumers() {
      return dependencies.terminalStreamConsumers()
    },
    get stopRequestedPtyIds() {
      return dependencies.stopRequestedPtyIds()
    },
    get wslDistroByPtyId() {
      return dependencies.wslDistroByPtyId()
    },
    get graphSequence() {
      return dependencies.graphSequence()
    },
    get graphStatus() {
      return dependencies.graphStatus()
    }
  }
}
