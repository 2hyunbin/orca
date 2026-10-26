import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { operationId, type FakeConnection } from './structured-chat-coordinator-fake-codex-fixture'

export function createChatPersonActions(deps: {
  host: () => StructuredAgentSessionHost
  connectionFor: (sessionId: string) => FakeConnection
}) {
  /** Codex's own sequence for a turn: it starts, echoes the user message, and completes. */
  async function settleTurn(
    sessionId: string,
    turnIndex: number,
    status?: 'completed' | 'failed'
  ): Promise<void> {
    const connection = deps.connectionFor(sessionId)
    const host = deps.host()
    const turn = connection.turns[turnIndex]!
    const turnId = turn.turnId ?? `turn-${turnIndex + 1}`
    const notify = (method: string, params: unknown) =>
      connection.handlers.onNotification?.(method, params)
    notify('turn/started', { turn: { id: turnId } })
    notify('item/completed', {
      item: {
        type: 'userMessage',
        id: `echo-${turn.clientUserMessageId}`,
        clientId: turn.clientUserMessageId,
        content: [{ type: 'text', text: 'pointer' }]
      }
    })
    notify('turn/completed', {
      turn: {
        id: turnId,
        ...(status ? { status } : {}),
        ...(status === 'failed' ? { error: { message: 'connection dropped' } } : {})
      }
    })
    await host.flushStreamedEvents(sessionId)
  }

  /** A user message typed into the chat, as the chat surface sends it. */
  function sendUserMessage(sessionId: string, text: string, delivery?: 'queue-if-active') {
    const host = deps.host()
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text }]
    }
    return host.send(
      { callerKey: 'test-surface' },
      {
        envelope: {
          sessionId,
          clientOperationId: operationId(),
          expectedRuntimeFence: host.deps.store.getRecord(sessionId)!.lease.runtimeFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId,
            fields: { body, ...(delivery ? { delivery } : {}) }
          })
        },
        body,
        ...(delivery ? { delivery } : {}),
        userSend: true
      }
    )
  }

  return { settleTurn, sendUserMessage }
}
