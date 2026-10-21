import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem,
  type AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import { HISTORY_CATCH_UP_MAX_OPERATIONS } from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'

/** Every saved item used by the projection is a conditional commit dependency, even if equal. */
export function createClaudeTranscriptItemReader(journal: StructuredAgentSessionTransitionJournal) {
  const dependencies = new Map<string, AgentJournalRenderItem>()
  const saved = (key: string) => {
    const held = dependencies.get(key)
    if (held) {
      return held
    }
    const item = journal.item(journal.canonicalItemId(key))
    if (item) {
      dependencies.set(key, item)
    }
    if (dependencies.size > HISTORY_CATCH_UP_MAX_OPERATIONS) {
      throw new Error('too-large')
    }
    return item
  }
  const scopeOf = (item: AgentJournalRenderItem): AgentJournalTurnScope => {
    const scope = item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
    if (scope.kind === 'turn') {
      const parent = saved(scope.turnItemId)
      if (!parent || parent.body.kind !== 'turn' || parent.body.state === 'running') {
        throw new Error('unsettled-history-turn')
      }
    }
    return scope
  }
  return { saved, scopeOf, dependencies }
}
