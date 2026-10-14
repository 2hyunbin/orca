import type { AgentJournalSubmission } from './agent-session-journal-types'
import { hasUnansweredStructuredAgentSessionDispatch } from './structured-agent-session-unanswered-dispatch'

/** Whether the session's own agent is working: a running turn, or a send it has not answered.
 *  The one rule behind every session list's Working and the chat's own Stop. */
export function isStructuredAgentSessionMainAgentWorking(
  activeTurnId: string | null,
  submissions: readonly AgentJournalSubmission[],
  currentFence?: number | null
): boolean {
  return (
    activeTurnId !== null || hasUnansweredStructuredAgentSessionDispatch(submissions, currentFence)
  )
}

/** Keep the chat's working presentation through the host's next queued send. */
export function isStructuredAgentSessionContinuouslyWorking(
  liveWorking: boolean,
  queueSendsNext: boolean
): boolean {
  return liveWorking || queueSendsNext
}
