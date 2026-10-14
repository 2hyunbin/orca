import { afterEach, beforeEach, expect, it } from 'vitest'
import type {
  AgentSessionQueuedMessage,
  AgentSessionHistoryPage,
  AgentSessionSubscribeEvent
} from '../../../../shared/agent-session-wire'
import {
  buildSubscriberFrame,
  type SubscriberFieldState
} from '../../../native-chat/agent-session-wire/agent-session-subscriber-frame-fields'
import { boundedQueuePublication } from '../../../native-chat/agent-session-wire/agent-session-bounded-queue'
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
    const event: AgentSessionSubscribeEvent = {
      type: 'batch',
      sessionId: SESSION,
      batch: {
        cursor: { epoch: 'a', sequence: 0 },
        items: [],
        removedItemIds: [],
        submissions: []
      }
    }
    for (const frame of buildSubscriberFrame(
      { readQueuePublication: () => queue },
      {
        sessionId: SESSION,
        boundedFrames: input.boundedFrames === true,
        projectQueuePublication: input.projectQueuePublication
      },
      event,
      false
    ).frames) {
      input.emit(frame)
    }
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

it('publishes phone text behind hidden images before bounding, and deduplicates the canonical queue', async () => {
  const images = Array.from({ length: 3 }, (_, index) => {
    const image = card(`image-${index}`, index + 1, true)
    image.body.blocks.unshift({ type: 'text', text: 'x'.repeat(200 * 1024) })
    return image
  })
  const text = card('text', images.length + 1, false)
  const queue = {
    queuedMessages: [...images, text],
    queuePause: { reason: 'stopped' as const },
    nextQueuedMessageId: null
  }
  expect(boundedQueuePublication(queue).queuedMessages).not.toContain(text)
  let built: ReturnType<typeof buildSubscriberFrame> | undefined
  hostCalls.subscribe.mockImplementation((input: AgentSessionSubscribeInput) => {
    const subscriber: SubscriberFieldState = {
      sessionId: SESSION,
      boundedFrames: input.boundedFrames === true,
      projectQueuePublication: input.projectQueuePublication
    }
    const event: AgentSessionSubscribeEvent = {
      type: 'batch',
      sessionId: SESSION,
      batch: { cursor: { epoch: 'a', sequence: 0 }, items: [], removedItemIds: [], submissions: [] }
    }
    built = buildSubscriberFrame({ readQueuePublication: () => queue }, subscriber, event, false)
    for (const frame of built.frames) {
      input.emit(frame)
    }
    expect(built.queued).toBe(queue)
    subscriber.queuePublication = built.queued
    expect(
      buildSubscriberFrame({ readQueuePublication: () => queue }, subscriber, event, false)
        .attachedQueued
    ).toBe(false)
    expect(
      buildSubscriberFrame({ readQueuePublication: () => queue }, subscriber, event, true).frames[0]
    ).not.toHaveProperty('queuedMessages')
    const page: AgentSessionHistoryPage = {
      sessionId: SESSION,
      epoch: 'a',
      direction: 'tail',
      items: [],
      removedItemIds: [],
      submissions: [],
      window: { oldest: null, newest: null, nextCursor: event.batch.cursor },
      hasOlder: false,
      hasNewer: false
    }
    const hydration: AgentSessionSubscribeEvent[] = [
      { type: 'snapshot', sessionId: SESSION, fence: 1, page },
      { type: 'reset', sessionId: SESSION, fence: 1, reset: 'epoch_changed', page }
    ]
    for (const frame of hydration) {
      expect(
        buildSubscriberFrame({ readQueuePublication: () => queue }, subscriber, frame, false).frames
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ queuedMessages: [text], queuePause: queue.queuePause })
        ])
      )
    }
    expect(buildSubscriberFrame({}, subscriber, event, false).frames[0]).not.toHaveProperty(
      'queuedMessages'
    )
    return () => {}
  })
  expect(
    await call('agentSession.subscribe', { sessionId: SESSION }, STRUCTURED_MOBILE_CLIENT)
  ).toMatchObject({
    result: {
      queuedMessages: [text],
      queuePause: queue.queuePause,
      nextQueuedMessageId: queue.nextQueuedMessageId
    }
  })
  expect(built?.frames[0]).toMatchObject({ queuedMessages: [text] })
})
