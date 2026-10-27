import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { AgentPromptExpectedBinding } from '../runtime/runtime-terminal-contracts'
import type { ExternalConversationLinkStore } from './external-conversation-links'
import type { PendingPrompt } from '../../shared/agent-pending-prompt'
import type { AgentTurnOutcome } from '../../shared/agent-turn-outcome'
import type {
  ConnectorAgent,
  ConnectorSource,
  ExternalConversationLink
} from '../../shared/external-conversation-link'

export type ConversationKey = { source: ConnectorSource; externalId: string }

export type ConversationPane = {
  conversation: ConversationKey
  worktreeId: string
  paneKey: string
}

export type ConversationEvent =
  | (ConversationPane & { kind: 'linked'; agent: ConnectorAgent })
  | (ConversationPane & { kind: 'prompt'; prompt: PendingPrompt })
  | (ConversationPane & { kind: 'turn-started'; at: number })
  | (ConversationPane & {
      kind: 'turn-ended'
      /** The ended turn's turn-started `at`; null when its start predates this watch and the row kept none. */
      turnId: number | null
      /** Host verdict; null means none was recorded. */
      stopReason: AgentTurnOutcome | null
      lastAssistantMessage?: string
      at: number
    })

export type ConversationSnapshot = {
  kind: 'snapshot'
  conversations: (ConversationPane & {
    agent: ConnectorAgent
    working: boolean
    prompt: PendingPrompt | null
    /** The pane's latest turn, as its turn events name it; null before any. */
    turnId: number | null
    /** When the conversation last showed activity: its link, or its agent's latest hook report. */
    activeAt: number
  })[]
}

export type ConversationWatchListener = (event: ConversationSnapshot | ConversationEvent) => void

export type ConversationEventsDeps = {
  store: ExternalConversationLinkStore
  readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
  readBinding: (paneKey: string) => AgentPromptExpectedBinding | null
  onAgentPaneChange: (listener: (change: AgentPaneChange) => void) => () => void
  pendingPrompt: (link: ExternalConversationLink) => PendingPrompt | null
  setTimer: (run: () => void, delayMs: number) => { cancel: () => void }
  now: () => number
}

export const CONNECTOR_REFUSALS = [
  'connectors_disabled',
  'agent_not_reachable',
  'unsupported_agent',
  'delivery_id_reused',
  'delivery_backlog_full',
  'agent_asleep_in_window',
  'no_session_to_reopen',
  'reopen_refused',
  // An answer's: the prompt was answered or moved on, only Orca can answer it, or no such option.
  'prompt_not_pending',
  'prompt_unsupported',
  'option_not_offered',
  // Queued or held work a cancel settled before it was written.
  'conversation_cancelled'
] as const
export type ConnectorRefusal = (typeof CONNECTOR_REFUSALS)[number]

/** accepted confirms writer completion, not agent receipt; reopened marks a resumed session before delivery. */
export type Delivery =
  | { outcome: 'accepted'; reopened?: true }
  | { outcome: 'refused'; reason: ConnectorRefusal }
  | {
      outcome: 'unknown'
      reason: 'launch_outcome_unknown' | 'writer_failed' | 'replayed_after_restart'
    }

export type ConversationStart = { conversation: ConversationKey; initial: Delivery }

export function refused(reason: ConnectorRefusal): Delivery {
  return { outcome: 'refused', reason }
}

// Encode the pair structurally to avoid collisions when IDs contain delimiters.
export function conversationId(key: ConversationKey): string {
  return JSON.stringify([key.source, key.externalId])
}
