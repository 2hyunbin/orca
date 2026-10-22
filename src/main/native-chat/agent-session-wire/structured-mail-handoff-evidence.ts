import { randomUUID } from 'node:crypto'
import type { StructuredAgentSessionConversationLifetime } from './structured-agent-session-conversation-lifetime'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'

export function readStructuredMailHandoffEvidence(
  host: StructuredAgentSessionHost,
  journal: AgentSessionJournal,
  sessionId: string,
  clientMessageId: string,
  incarnation: string
) {
  const submission =
    journal.submission(clientMessageId) ??
    journal.submissions().find((candidate) => candidate.queuedMessageId === clientMessageId)
  const boundary = host.deps.store.getRecord(sessionId)?.providerContextBoundary
  const owner =
    submission && (!boundary || submission.fence > boundary.afterFence)
      ? journal.submissionHandoff(submission.clientMessageId)
      : null
  const work = host.currentWork(sessionId)
  const body = submission
    ? journal.itemBody(agentJournalSubmissionKey(submission.clientMessageId))
    : null
  const notice = body?.kind === 'message' ? body.from?.orchestration : null
  return {
    legacyNotice: notice?.message === 'mail-notice' ? notice : null,
    epoch: journal.cursor().epoch,
    frontier: JSON.stringify([
      incarnation,
      boundary?.operationId ?? null,
      journal
        .submissions()
        .reduce(
          (latest, candidate) =>
            candidate.dispatchState === 'accepted' &&
            candidate.origin === 'client' &&
            candidate.source?.kind !== 'agent'
              ? Math.max(latest, candidate.submittedSequence ?? 0)
              : latest,
          0
        )
    ]),
    stopInForce: journal.queuedMessages.userStopInForce() !== null,
    submission,
    owner,
    latestTurn: journal.newestTurn(),
    acceptedUnopened: journal.stopMarks.latestAcceptedSendUnopened(),
    personStopped: owner
      ? journal.stopMarks.personStopDecides(owner.turn.turnId, owner.turn.completedAt)
      : false,
    diedTurnId: work?.diedTurn()?.turnId ?? null
  }
}

export function read(
  host: StructuredAgentSessionHost,
  lifetime: () => StructuredAgentSessionConversationLifetime
) {
  return async (sessionId: string, clientMessageId: string) => {
    const { journal } = await lifetime().conversation(sessionId)
    return journal.readInOrder(() => host.readMailHandoffEvidenceNow(sessionId, clientMessageId))
  }
}

export function readNow(
  host: StructuredAgentSessionHost,
  sessions: () => StructuredAgentSessionConversations
) {
  const incarnation = randomUUID()
  return (sessionId: string, clientMessageId: string) => {
    const journal = sessions().get(sessionId)?.journal
    return journal
      ? readStructuredMailHandoffEvidence(host, journal, sessionId, clientMessageId, incarnation)
      : null
  }
}

export function snapshot(lifetime: () => StructuredAgentSessionConversationLifetime) {
  return async (sessionId: string) => (await lifetime().conversation(sessionId)).journal.snapshot()
}
