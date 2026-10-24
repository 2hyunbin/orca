import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { StructuredAgentSessionContinuationHost } from './structured-agent-session-restart-continuation'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
// Binds the restart-resume surface to the host's own capabilities.
//
// Its own file because the bindings carry real decisions — which caller key the continuation sends
// under, that the verdict comes from the settlement waiter rather than the send result, — and those belong next to the collaborator that consumes them
// rather than buried in the host constructor.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionSendResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { MAX_TIMER_DELAY_MS } from '../../../shared/timer-delay'
import type { SendSettlementWaitOptions } from './structured-agent-session-send-settlement'

export type StructuredAgentSessionRestartResumeSurfaces = {
  automatic?: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  revealSession: (
    sessionId: string
  ) => Promise<{ readable: boolean; openRefusal?: AgentSessionWireRefusal }>
  send: (input: {
    envelope: AgentSessionMutationEnvelope
    body: AgentJournalMessageItem
    beforeRun?: () => void
  }) => Promise<AgentSessionMutationResult<AgentSessionSendResult>>
  awaitSendSettlement: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<{ value: AgentSessionSendResult } | undefined>
  awaitSendHandedOver: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<{ value: AgentSessionSendResult } | undefined>
  readChildWork: (sessionId: string) => readonly AgentChildWorkView[] | undefined
  childWorkOpen: (sessionId: string) => boolean
  publishStatus?: (sessionId: string) => void
  now: () => number
}

export const STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER =
  'trusted-local:restart-continuation'

type RestartResumeHostBindings = {
  withAutomaticConversation?: StructuredAgentSessionRestartResumeSurfaces['automatic']
  revealSession: StructuredAgentSessionRestartResumeSurfaces['revealSession']
  send: (
    caller: { callerKey: string },
    params: {
      envelope: AgentSessionMutationEnvelope
      body: AgentJournalMessageItem
      beforeRun?: () => void
    }
  ) => Promise<AgentSessionMutationResult<AgentSessionSendResult>>
  waitForSendSettlement: (
    sessionId: string,
    clientMessageId: string,
    options: SendSettlementWaitOptions
  ) => Promise<{ value: AgentSessionSendResult } | undefined>
}

export function structuredAgentSessionRestartResumeSurfaces(
  host: RestartResumeHostBindings,
  now: () => number
): Omit<StructuredAgentSessionRestartResumeSurfaces, 'readChildWork' | 'childWorkOpen'> {
  return {
    revealSession: host.revealSession,
    automatic: host.withAutomaticConversation,
    send: (params) =>
      host.send({ callerKey: STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER }, params),
    // Provider settlement decides delivery; cold startup may exceed ordinary client waits.
    awaitSendSettlement: (sessionId, clientMessageId) =>
      host.waitForSendSettlement(sessionId, clientMessageId, { budgetMs: MAX_TIMER_DELAY_MS }),
    // Release batch capacity at handover/start failure or an inconclusive ended wait.
    awaitSendHandedOver: (sessionId, clientMessageId) =>
      host.waitForSendSettlement(sessionId, clientMessageId, {
        until: 'handed-over',
        budgetMs: MAX_TIMER_DELAY_MS
      }),
    now
  }
}

export function createRestartContinuationHost(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'logger'>,
  sessions: StructuredAgentSessionContinuationHost['sessions'],
  surfaces: StructuredAgentSessionRestartResumeSurfaces,
  stillResumable: StructuredAgentSessionContinuationHost['stillResumable']
): StructuredAgentSessionContinuationHost {
  return {
    ...surfaces,
    logger: deps.logger,
    sessions,
    conversationFence: (sessionId) =>
      deps.store.getRecord(sessionId)
        ? structuredAgentSessionConversationFence(deps.store, sessionId)
        : null,
    stillResumable
  }
}
