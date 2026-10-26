import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { operationId, type FakeConnection } from './structured-chat-coordinator-fake-codex-fixture'

export function createChatPersonActions(deps: {
  host: () => StructuredAgentSessionHost
  connectionFor: (sessionId: string) => FakeConnection
}) {
  async function startTurn(sessionId: string, turnIndex: number, text = 'pointer') {
    const connection = deps.connectionFor(sessionId)
    const turn = connection.turns[turnIndex]!
    const turnId = turn.turnId ?? `turn-${turnIndex + 1}`
    connection.handlers.onNotification?.('turn/started', {
      turn: { id: turnId, status: 'inProgress' }
    })
    connection.handlers.onNotification?.('item/completed', {
      turnId,
      item: {
        type: 'userMessage',
        id: `echo-${turn.clientUserMessageId}`,
        clientId: turn.clientUserMessageId,
        content: [{ type: 'text', text }]
      }
    })
    await deps.host().flushStreamedEvents(sessionId)
  }

  async function finishTurn(
    sessionId: string,
    turnIndex: number,
    status?: 'completed' | 'failed',
    reply = false
  ) {
    const connection = deps.connectionFor(sessionId)
    const turnId = connection.turns[turnIndex]!.turnId ?? `turn-${turnIndex + 1}`
    if (reply) {
      connection.handlers.onNotification?.('item/completed', {
        turnId,
        item: { type: 'agentMessage', id: `reply-${turnIndex}`, text: `Finished ${turnIndex}` }
      })
      connection.handlers.onNotification?.('thread/status/changed', { status: { type: 'idle' } })
    }
    connection.handlers.onNotification?.('turn/completed', {
      turn: {
        id: turnId,
        ...(status ? { status } : {}),
        ...(status === 'failed' ? { error: { message: 'connection dropped' } } : {})
      }
    })
    await deps.host().flushStreamedEvents(sessionId)
  }

  async function settleTurn(sessionId: string, turnIndex: number, status?: 'completed' | 'failed') {
    await startTurn(sessionId, turnIndex)
    await finishTurn(sessionId, turnIndex, status)
  }

  function envelope(sessionId: string, method: string, fields: Record<string, unknown>) {
    return {
      sessionId,
      clientOperationId: operationId(),
      expectedRuntimeFence: deps.host().deps.store.getRecord(sessionId)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({ method, sessionId, fields })
    }
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
        envelope: envelope(sessionId, 'agentSession.send', {
          body,
          ...(delivery ? { delivery } : {})
        }),
        body,
        ...(delivery ? { delivery } : {}),
        userSend: true
      }
    )
  }

  return { startTurn, finishTurn, settleTurn, envelope, sendUserMessage }
}
