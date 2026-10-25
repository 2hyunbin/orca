import type {
  AgentStatusIpcPayload,
  ParsedAgentStatusPayload,
  TurnEndDisposition
} from '../../../../shared/agent-status-types'
import type { RecognizedAgentProcess } from '../../../../shared/agent-process-recognition'
import type { TerminalProcessInspection } from '../../../../shared/terminal-process-inspection'

export type AgentCompletionStatusSnapshot = ParsedAgentStatusPayload &
  Partial<
    Pick<
      AgentStatusIpcPayload,
      | 'runId'
      | 'executionId'
      | 'terminalHandle'
      | 'connectionId'
      | 'turnStartedAt'
      | 'authorityRestartId'
      | 'isReplay'
      | 'restoredUnconfirmed'
    >
  > & {
    stateStartedAt?: number
    turnEndedAt?: number
    turnEndDisposition?: TurnEndDisposition
    /** Renderer-local boundary used only to reject a delayed cross-host completion. */
    localStateStartedAt?: number
  }

export type AgentCompletionHookCandidate = {
  snapshot: AgentCompletionStatusSnapshot
  originalRow: AgentStatusIpcPayload
}

export type AgentCompletionDispatchMeta = {
  source: 'hook' | 'title' | 'process-exit'
  quietedHookDone: boolean
  hookCandidate?: AgentCompletionHookCandidate
  terminalIdleConfirmed?: boolean
  agentStatus?: AgentCompletionStatusSnapshot
}

export type AgentAttentionDispatchMeta = {
  hookCandidate?: AgentCompletionHookCandidate
  source: 'hook'
  agentStatus: AgentCompletionStatusSnapshot
}

export type AgentCompletionCoordinatorOptions = {
  paneKey: string
  statusLane?: 'hook' | 'pty'
  getPtyId: () => string | null
  /** Remote authorities are event-triggered only; no periodic process polls. */
  isRemotePtyId?: (ptyId: string) => boolean
  getExpectedIncarnationId?: () => string | null
  inspectProcess: (
    ptyId: string,
    options?: { expectedIncarnationId?: string; steadyState?: boolean }
  ) => Promise<TerminalProcessInspection>
  /** Rechecks a local exit candidate without trusting the inspection's cached process name. */
  confirmForegroundProcess?: (ptyId: string) => Promise<string | null>
  dispatchCompletion: (title: string, meta?: AgentCompletionDispatchMeta) => void
  dispatchAttention?: (title: string, meta: AgentAttentionDispatchMeta) => void
  dispatchHookLifecycle?: (payload: AgentCompletionStatusSnapshot) => void
  shouldSuppressProcessReplacementCompletion?: (
    exited: RecognizedAgentProcess,
    replacement: RecognizedAgentProcess
  ) => boolean
  shouldSuppressConfirmedProcessExitCompletion?: (exited: RecognizedAgentProcess) => boolean
  /** Fired once per confirmed exit (settled local absence, or the host's `exited` verdict). */
  onForegroundAgentExited?: (exited: RecognizedAgentProcess) => void
  isLive: () => boolean
  /** Identified ends belong to hooks; ambiguous ends retain title-lane authority; null means no hook ownership. */
  titleTurnEndEvidence?: (
    title: string | null,
    foregroundAgent: RecognizedAgentProcess['agent'] | null
  ) => 'identified' | 'ambiguous' | null
  /** An idle edge whose turn end the hook lane announces still ends this output burst. */
  onHookOwnedTitleIdle?: () => void
  /** Whether a hook snapshot's end is hook-owned on this pane (else main's behavior exactly). */
  usesHookTurnEnds?: (snapshot: AgentCompletionStatusSnapshot) => boolean
  shouldPollProcessCadence?: () => boolean
  // Disable idle polling only after consuming host inventory evidence and distinguishing absent evidence from older hosts that cannot publish it.
  shouldPollNoEvidenceProcessCadence?: () => boolean
  // Relax costly no-evidence scans (Windows or remote host reads); output/title/hooks re-arm hot cadence.
  isProcessInspectionCostly?: () => boolean
}

export type AgentCompletionCoordinator = {
  observeTitle: (title: string) => void
  observeClassifiedTitleCompletion: (title: string) => void
  observeTitleWorking: () => void
  observeOutputActivity: () => void
  observeHookStatus: (payload: AgentCompletionStatusSnapshot) => void
  seedHookStatus: (payload: AgentCompletionStatusSnapshot) => void
  startProcessTracking: () => void
  /** Another reader saw this agent in the foreground; lets the monitor confirm its exit. */
  observeForegroundAgentProcess: (process: RecognizedAgentProcess) => void
  hasPendingHookDoneCompletion: () => boolean
  /** Whether a turn end observed now could be announced (live, with agent evidence, not re-arming). */
  canAnnounceCompletion: () => boolean
  resetCompletionState: (options?: { requireFreshWorking?: boolean }) => void
  dispose: () => void
}
