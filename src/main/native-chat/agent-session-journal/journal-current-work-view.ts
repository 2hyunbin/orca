import type {
  AgentJournalRenderItem,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionContextUsage } from '../../../shared/agent-session-context-usage'
import { latestStructuredAgentContextFacts } from '../../../shared/structured-agent-session-context-usage'
import {
  newestStructuredAgentSessionTurnBySequence,
  runningStructuredAgentSessionTurnItemBySequence
} from '../../../shared/structured-agent-session-live-turn'
import type { JournalReducerState } from './journal-reducer'
import { journalThreadGoalSource, type JournalThreadGoalSource } from './journal-thread-goal-source'

export function createJournalCurrentWorkView(state: () => JournalReducerState) {
  return {
    runningTurn: (): { item: AgentJournalRenderItem; turnId: string } | null =>
      runningStructuredAgentSessionTurnItemBySequence(state().items.values()),
    newestTurn: (): AgentJournalTurnLifecycle | null =>
      newestStructuredAgentSessionTurnBySequence(state().items.values()),
    threadGoalSource: (): JournalThreadGoalSource =>
      journalThreadGoalSource(state().items.values()),
    contextUsage: (): AgentSessionContextUsage =>
      latestStructuredAgentContextFacts(state().items.values())
  }
}
