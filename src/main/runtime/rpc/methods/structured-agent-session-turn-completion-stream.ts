// Emit future turn completions and opted-in prompts only; unlike status snapshots, missed edges never replay.

import { defineMethod, defineStreamingMethod } from '../core'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import {
  requireStructuredCapability,
  requireStructuredHost as requireHost,
  requireStructuredSessionHost
} from './structured-agent-session-gate'
import {
  AcknowledgeAttentionParams,
  SubscribeTurnCompletionsParams
} from './structured-agent-session-schemas'
import { structuredAgentSessionTurnCompletionSubscriptionId } from './structured-agent-session-subscription-id'
import { bindStructuredAgentSessionStream } from './structured-agent-session-status-stream'
import { clientReadsStructuredSessionAgent } from './structured-agent-session-policy'

export const STRUCTURED_AGENT_SESSION_TURN_COMPLETION_METHODS = [
  // Retire only prompt deliveries covered by the accepted read's session/epoch, without installing the host.
  defineMethod({
    name: 'agentSession.acknowledgeAttention',
    permission: 'workspace',
    params: AcknowledgeAttentionParams,
    handler: (params, ctx) => {
      requireStructuredCapability(ctx)
      ctx.runtime.retireStructuredAttention({
        sessionId: params.sessionId,
        observedCursor: params.observedCursor
      })
      return { acknowledged: true }
    }
  }),
  defineStreamingMethod({
    name: 'agentSession.subscribeTurnCompletions',
    permission: 'workspace',
    params: SubscribeTurnCompletionsParams,
    handler: async (params, ctx, emit) => {
      const sessionId = params.phoneRelaySessionId
      const host = sessionId ? requireStructuredSessionHost(ctx, sessionId) : requireHost(ctx)
      if (
        sessionId &&
        (!host.sessionAgent(sessionId) ||
          ctx.clientKind !== 'runtime' ||
          ctx.caller?.kind !== 'paired-device')
      ) {
        throw agentSessionRefusalError('structured_agent_session_unsupported', {
          reason: 'clientCapabilityMissing'
        })
      }
      const subscriptionId = structuredAgentSessionTurnCompletionSubscriptionId(ctx)
      let dispose = (): void => {}
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => dispose())
      if (stream.isClosed()) {
        return
      }
      dispose = host.subscribeTurnCompletions({
        id: subscriptionId,
        // A client that cannot read an agent's rows is not told that agent's edges either.
        emit: (event) => {
          const sessionId =
            event.type === 'completion'
              ? event.completion.sessionId
              : event.type === 'prompt'
                ? event.prompt.sessionId
                : undefined
          if (
            sessionId === undefined ||
            clientReadsStructuredSessionAgent(ctx, host.sessionAgent(sessionId) ?? '')
          ) {
            emit(event)
          }
        },
        includePrompts: params.includePrompts === true,
        ...(sessionId && ctx.caller?.kind === 'paired-device'
          ? { phoneRelay: { sessionId, callerKey: ctx.caller.deviceId } }
          : {})
      })
      if (stream.isClosed()) {
        dispose()
      }
    }
  })
]
