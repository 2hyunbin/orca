import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionQueuedMessagesClearResult
} from '../../../shared/agent-session-wire'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import type { TurnOutcome } from './structured-agent-session-turns'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import {
  mutateQueued,
  withdrawQueuedMessagesForOperation
} from './structured-agent-session-queued-mutations'

/** Clear the caller's captured host cards on the session lane in one journal transaction. */
export function clearQueuedStructuredAgentMessages(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; messageIds: string[] }
): Promise<AgentSessionMutationResult<AgentSessionQueuedMessagesClearResult>> {
  const { messageIds } = params
  const operationId = params.envelope.clientOperationId
  let answer: AgentSessionQueuedMessagesClearResult | undefined
  const plan: MutationPlan<AgentSessionQueuedMessagesClearResult> = {
    method: 'agentSession.queuedMessagesClear',
    fields: { messageIds },
    conversationWrite: true,
    commandReceipt: {
      result: () => {
        if (!answer) {
          throw new Error('queued clear answer missing at commit')
        }
        return { kind: 'queued-clear', ...answer }
      },
      unwritten: (value) => ({ kind: 'queued-clear', ...value })
    },
    run: async (ctx): Promise<TurnOutcome<AgentSessionQueuedMessagesClearResult>> => {
      const withdrawn: string[] = []
      const dispatched: string[] = []
      const missing: string[] = []
      for (const messageId of messageIds) {
        const row = ctx.journal.queuedMessages.get(messageId)
        if (row?.state === 'waiting' || row?.state === 'returned') {
          withdrawn.push(messageId)
        } else if (row?.state === 'dispatched') {
          dispatched.push(messageId)
        } else {
          missing.push(messageId)
        }
      }
      answer = { withdrawn, dispatched, missing }
      if (withdrawn.length > 0) {
        await withdrawQueuedMessagesForOperation(
          ctx.journal,
          {
            sessionId: ctx.sessionId,
            messageIds: withdrawn,
            callerKey: ctx.resolvedBy,
            operationId
          },
          ctx.operationReceipt
        )
      }
      return { ok: true, value: answer }
    },
    replay: (_ctx, _outcome, receipt) =>
      receipt?.kind === 'queued-clear'
        ? {
            withdrawn: receipt.withdrawn,
            dispatched: receipt.dispatched,
            missing: receipt.missing
          }
        : null
  }
  return mutateQueued(context, caller, params.envelope, plan)
}
