import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import type { StructuredAgentSessionConversationLifetime } from './structured-agent-session-conversation-lifetime'
import { StructuredAgentSessionUsageLimitContinue } from './structured-agent-session-usage-limit-continue'
import { sleepStructuredAgentSessionWorkspace } from './structured-agent-session-workspace-sleep'

export function createUsageLimitContinue(
  context: StructuredAgentSessionMutationContext,
  host: Pick<StructuredAgentSessionHost, 'send'>,
  delivery: { publishStatus: (id: string) => void }
): StructuredAgentSessionUsageLimitContinue {
  return new StructuredAgentSessionUsageLimitContinue({
    host: context.deps,
    sessions: context.sessions,
    serialize: context.serialize,
    send: (params) => host.send({ callerKey: 'trusted-local:usage-limit-continue' }, params),
    publish: delivery.publishStatus,
    now: context.now
  })
}

export function sleepWorkspace(
  context: StructuredAgentSessionMutationContext,
  tasks: StructuredAgentSessionTaskQueue,
  lifetime: StructuredAgentSessionConversationLifetime,
  deliveryRunning: (id: string) => boolean,
  workspaceId: string
): Promise<{ stoppedSessionIds: string[] }> {
  return sleepStructuredAgentSessionWorkspace(
    { ...context, tasks, lifetime, deliveryRunning },
    workspaceId
  )
}

export function stopDeliveryWork(...work: { dispose: () => void }[]): void {
  work.forEach((item) => item.dispose())
}
