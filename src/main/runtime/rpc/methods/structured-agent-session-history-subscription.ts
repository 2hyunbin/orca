import { defineStreamingMethod } from '../core'
import { SubscribeParams } from './structured-agent-session-schemas'
import { requireInstalledStructuredHost as requireInstalledHost } from './structured-agent-session-gate'
import { clientReadsCurrentRequests } from './structured-agent-session-current-requests'
import { clientSupportsSnapshotCatchUp } from './structured-agent-session-history-capability'
import { projectTurnItemEvent } from './structured-agent-session-turn-item-capability'
import { projectBackgroundTaskEvent } from './structured-agent-session-background-task-capability'
import { projectQueuedImageCardPublication } from './structured-agent-session-queued-image-capability'
import { bindStructuredAgentSessionStream } from './structured-agent-session-status-stream'
import { structuredAgentSessionSubscriptionId as subscriptionIdFor } from './structured-agent-session-subscription-id'
import { beginStructuredJournalForeground } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'

export const STRUCTURED_AGENT_SESSION_HISTORY_SUBSCRIPTION = defineStreamingMethod({
  name: 'agentSession.subscribe',
  permission: 'workspace',
  params: SubscribeParams,
  handler: async (params, ctx, emit) => {
    const finishForeground = beginStructuredJournalForeground(ctx.signal)
    try {
      const host = await requireInstalledHost(ctx, params.sessionId)
      const subscriptionId = subscriptionIdFor(ctx, params.sessionId)
      // A stream reads; it never keeps an agent alive or starts one.
      let dispose = (): void => {}
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => dispose())
      if (stream.isClosed()) {
        return
      }
      // Resolves once the conversation is open and the opening snapshot (or the missed batch) is
      // emitted; a close that raced the open disposes what it bound.
      dispose = await host.subscribe({
        readsCurrentRequests: clientReadsCurrentRequests(ctx),
        id: subscriptionId,
        sessionId: params.sessionId,
        projectQueuePublication: (publication) =>
          projectQueuedImageCardPublication(publication, ctx),
        emit: (event) =>
          emit(
            projectTurnItemEvent(
              projectBackgroundTaskEvent(event, ctx),
              ctx,
              host.sessionAgent(params.sessionId)
            )
          ),
        ...(params.cursor ? { cursor: params.cursor } : {}),
        snapshotCatchUp: clientSupportsSnapshotCatchUp(ctx),
        // Every phone's app, whatever its version, ends a stream over a frame its bridge cannot carry.
        ...(ctx.clientKind === 'mobile' ? { boundedFrames: true } : {})
      })
      if (stream.isClosed()) {
        dispose()
      }
    } finally {
      finishForeground()
    }
  }
})
