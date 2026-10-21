// The chat's half of a switch to its terminal. Unlike a tab close, a switch never cuts work short
// (the user stops a reply first), so it is admitted only when the chat is idle, and its admission
// has no effect of its own: no start is aborted and nothing is stopped before it passes.

import { agentSessionLeaseOwnerVerdict } from '../../../shared/agent-session-lease-adjudication'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

/** In the chat's ordered step: refuses unless nothing is running, starting, queued or owed, then
 *  admits, stops through close's body, and proves the agent gone before anything starts elsewhere. */
export async function stopIdleStructuredAgentSessionForSwitch(
  idle: {
    session: StructuredAgentSessionHostSession | undefined
    delivering: boolean
    idleSweep: {
      owesWork: (sessionId: string, session: StructuredAgentSessionHostSession) => boolean
    }
  },
  stop: () => Promise<unknown>,
  record: () => AgentSessionRecord | null
): Promise<void> {
  const { session } = idle
  if (
    idle.delivering ||
    (session !== undefined &&
      (session.child?.phase === 'starting' ||
        session.journal.submissions().some(isQueuedAgentJournalSubmission) ||
        (session.child !== null &&
          idle.idleSweep.owesWork(session.params.envelope.sessionId, session))))
  ) {
    throw agentSessionRefusalError('agent_session_operation_invalid', { reason: 'turnActive' })
  }
  await stop()
  const lease = record()?.lease
  if (!lease || agentSessionLeaseOwnerVerdict(lease) !== 'exited') {
    throw agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'ownerUnproven' })
  }
}
