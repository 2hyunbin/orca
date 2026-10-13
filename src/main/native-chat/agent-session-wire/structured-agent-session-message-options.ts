import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { isAgentSessionOptionRejectedError } from './structured-agent-session-option-error'

const OPTION_ORDER = ['model', 'effort', 'personality', 'fastMode', 'serviceTier'] as const

function sameOptions(
  a: AgentSessionExecutionOptions | undefined,
  b: AgentSessionExecutionOptions | undefined
): boolean {
  return OPTION_ORDER.every((key) => a?.[key] === b?.[key])
}

/** A different Codex choice needs a new turn: steer has no choice parameters. */
export function waitsForCodexTurnOptions(
  journal: Pick<AgentSessionJournal, 'activeTurnId' | 'submissions' | 'item'>,
  next: AgentJournalSubmission
): boolean {
  const activeTurnId = journal.activeTurnId()
  if (!activeTurnId) {
    return false
  }
  const active = journal.submissions().find((submission) => {
    if (submission.handedOverAt === undefined) {
      return false
    }
    const item = journal.item(agentJournalSubmissionKey(submission.clientMessageId))
    return item?.turnScope?.kind === 'turn' && item.turnScope.turnItemId === activeTurnId
  })
  return active ? !sameOptions(active.executionOptions, next.executionOptions) : true
}

/** Only the provider's live selection changes here; the saved picker choice stays for future sends. */
export async function applyMessageExecutionOptions(
  adapter: Pick<StructuredAgentSessionAdapter, 'setOption'>,
  sessionId: string,
  fence: number,
  options: AgentSessionExecutionOptions | undefined
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!options) {
    return { ok: true }
  }
  for (const key of OPTION_ORDER) {
    const value = options[key]
    if (value === undefined) {
      continue
    }
    try {
      await adapter.setOption({ sessionId, fence, key, value })
    } catch (error) {
      if (isAgentSessionOptionRejectedError(error)) {
        return { ok: false, reason: error.message }
      }
      throw error
    }
  }
  return { ok: true }
}
