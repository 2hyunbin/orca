import type {
  AgentJournalAnsweredTurnIdentity,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentJournalDispatchRejection } from '../../../shared/agent-session-failure-words'
import type { ResolveDispatchInput } from '../agent-session-journal/journal-store-contracts'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import { whileStructuredAgentSessionHandingOver } from './structured-agent-session-handing-over'

/** Settle a provider-proven outcome independently of an in-flight client mutation. `unknown` is
 *  released doubt: the provider let the send go unanswered, so nothing re-sends it. The send reads
 *  held until its row settles; a failed write leaves it unanswered, which clients learn at once.
 *  `sendAnswered` saves the turn the provider answered the send into, which settles nothing. */
export async function settleStructuredAgentSessionLateDispatch(
  context: StructuredAgentSessionMutationContext,
  input: {
    sessionId: string
    clientMessageId: string
  } & (
    | { providerIdentity: AgentJournalItemIdentity }
    | { sendAnswered: { turnItemId: string } }
    | ({
        state: 'rejected'
        answeredInTurn?: AgentJournalAnsweredTurnIdentity
      } & AgentJournalDispatchRejection)
    | { state: 'unknown'; reason: string }
  )
): Promise<void> {
  const session = context.sessions.get(input.sessionId)
  if (!session) {
    return
  }
  const fence = structuredAgentSessionConversationFence(context.deps.store, input.sessionId)
  const { journal } = session
  if ('sendAnswered' in input) {
    // A planned batch so the fold decides: a mark already saved is not written twice.
    await journal.appendPlannedLifecycleBatch({
      settlementId: `send-answered:${input.clientMessageId}`,
      fence,
      plan: () => ({
        mutations: [],
        dispatches: [],
        observed: [
          {
            clientMessageId: input.clientMessageId,
            epoch: journal.epoch,
            answeredTurnItemId: input.sendAnswered.turnItemId
          }
        ]
      })
    })
    return
  }
  const settlement: ResolveDispatchInput =
    'providerIdentity' in input
      ? {
          clientMessageId: input.clientMessageId,
          state: 'accepted',
          providerIdentity: input.providerIdentity,
          fence
        }
      : input.state === 'unknown'
        ? {
            clientMessageId: input.clientMessageId,
            state: 'unknown',
            reason: input.reason,
            fence,
            recovered: true
          }
        : {
            clientMessageId: input.clientMessageId,
            state: 'rejected',
            reason: input.reason,
            rejection: input.rejection,
            ...(input.answeredInTurn ? { answeredInTurn: input.answeredInTurn } : {}),
            fence
          }
  try {
    // The journal queue drains before close; the host queue would defer this past teardown.
    await whileStructuredAgentSessionHandingOver(journal, input.clientMessageId, () =>
      journal.resolveDispatch(settlement)
    )
  } catch (error) {
    context.publishWorkChanged(input.sessionId)
    throw error
  }
}
