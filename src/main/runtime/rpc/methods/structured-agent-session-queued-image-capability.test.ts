import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import type { AgentSessionSubscribeInput } from '../../../native-chat/agent-session-wire/structured-agent-session-subscribers'
import {
  call,
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  SESSION,
  STRUCTURED_CLIENT,
  STRUCTURED_MOBILE_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(installStructuredHostStub)
afterEach(clearStructuredHostStub)

function card(messageId: string, position: number, image: boolean): AgentSessionQueuedMessage {
  return {
    messageId,
    position,
    state: 'waiting',
    body: {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: messageId },
        ...(image ? [{ type: 'image-ref' as const, path: '/tmp/shot.png' }] : [])
      ]
    }
  }
}

const TEXT = card('text', 2, false)
const IMAGE = card('image', 1, true)
const DESKTOP = {
  clientKind: 'runtime' as const,
  clientCapabilities: [...DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES]
}

it('withholds image cards from a reader that predates them, on history and the stream', async () => {
  const queue = {
    queuedMessages: [IMAGE, TEXT],
    queuePause: { reason: 'stopped' as const },
    nextQueuedMessageId: 'image'
  }
  hostCalls.history.mockReturnValue({ ok: true, page: { items: [], ...queue } })
  hostCalls.subscribe.mockImplementation((input: AgentSessionSubscribeInput) => {
    input.emit({
      type: 'batch',
      sessionId: SESSION,
      batch: {
        cursor: { epoch: 'a', sequence: 0 },
        items: [],
        removedItemIds: [],
        submissions: []
      },
      ...queue
    })
    return () => {}
  })
  const read = async (client: Parameters<typeof call>[2]) => [
    await call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, client),
    await call('agentSession.subscribe', { sessionId: SESSION }, client)
  ]
  // The local renderer is a negotiated reader too: its own list must carry the capability.
  for (const client of [DESKTOP, undefined]) {
    const [history, stream] = await read(client)
    expect(history).toMatchObject({ result: { page: queue } })
    expect(stream).toMatchObject({ result: queue })
  }
  for (const client of [STRUCTURED_CLIENT, STRUCTURED_MOBILE_CLIENT]) {
    const [history, stream] = await read(client)
    // Positions, the pause over a card it sees, and the next card's id stay as the host published.
    const withheld = { ...queue, queuedMessages: [TEXT] }
    expect(history).toMatchObject({ result: { page: withheld } })
    expect(stream).toMatchObject({ result: withheld })
  }

  // With no card left to show, no pause either: its Resume would send only what it cannot see.
  hostCalls.history.mockReturnValue({
    ok: true,
    page: { items: [], ...queue, queuedMessages: [IMAGE] }
  })
  expect(
    await call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, STRUCTURED_CLIENT)
  ).toMatchObject({ result: { page: { queuedMessages: [], queuePause: null } } })
})
