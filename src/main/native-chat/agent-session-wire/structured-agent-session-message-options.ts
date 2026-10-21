import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'

const OPTION_ORDER = ['model', 'effort', 'serviceTier'] as const

/** Steering keeps the admitted turn inputs; provider observations cannot veto a send. */
function sameOptions(
  a: AgentSessionExecutionOptions | undefined,
  b: AgentSessionExecutionOptions | undefined,
  applied?: AgentSessionExecutionOptions
): boolean {
  if ((a === undefined) !== (b === undefined)) {
    return false
  }
  const tier = (options: AgentSessionExecutionOptions | undefined) =>
    options?.serviceTier ??
    (options?.fastMode === 'true'
      ? 'priority'
      : options?.fastMode === 'false'
        ? 'default'
        : undefined)
  return OPTION_ORDER.every((key) =>
    key === 'serviceTier'
      ? tier(a) === tier(b)
      : (a?.[key] ?? applied?.[key]) === (b?.[key] ?? applied?.[key])
  )
}

/** A different Codex model, effort or speed needs a new turn: steer has no choice parameters. */
export function waitsForCodexTurnOptions(
  record: Pick<AgentSessionRecord, 'provider' | 'sessionId'> | null,
  journal: Pick<AgentSessionJournal, 'newestTurn' | 'submissions' | 'itemBody'>,
  next: AgentJournalSubmission,
  child: StructuredAgentSessionProviderChild,
  adapter?: Pick<StructuredAgentSessionAdapter, 'readAppliedInputOptions'>
): boolean {
  if (record?.provider !== 'codex') {
    return false
  }
  const applied = adapter?.readAppliedInputOptions?.({
    sessionId: record.sessionId,
    fence: child.fence,
    acquisitionGeneration: child.generation,
    next: next.options
  })
  const body = journal.itemBody(agentJournalSubmissionKey(next.clientMessageId))
  if (body?.kind !== 'message' || body.command) {
    return false
  }
  const turn = journal.newestTurn()
  if (turn?.state !== 'running') {
    return false
  }
  const active = journal.submissions().find((submission) => {
    if (submission.handedOverAt === undefined) {
      return false
    }
    return agentJournalSubmissionKey(submission.clientMessageId) === turn.userItemId
  })
  return active
    ? !sameOptions(
        applied?.active ?? active.options,
        applied?.next ?? next.options,
        applied?.active
      )
    : true
}
