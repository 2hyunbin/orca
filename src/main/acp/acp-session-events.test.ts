import { describe, expect, it } from 'vitest'
import { readAcpFixture } from './acp-timeline-fixture.test-support'
import { readAcpSessionEvent } from './acp-session-events'
import { SessionNotificationSchema } from './generated/acp-protocol.generated'

describe('compiled ACP session notifications', () => {
  it('matches the runtime parser across the captured session updates', async () => {
    const frames = await readAcpFixture('s1-full-notifications')
    const notifications = frames.filter((frame) => frame.message.method === 'session/update')
    expect(notifications.length).toBeGreaterThan(0)
    for (const frame of notifications) {
      const params = frame.message.params
      const original = SessionNotificationSchema.safeParse(params)
      const event = readAcpSessionEvent(params)
      if (original.success) {
        expect(event).toEqual({ kind: 'known', notification: original.data })
      } else {
        expect(event).toMatchObject({ kind: 'unrecognized', raw: params })
      }
    }
  })

  it('preserves additive fields and open enum values without mutating the input', () => {
    const params = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Search',
        kind: 'future-tool-kind',
        content: [],
        vendor: { retained: true }
      },
      vendor: true
    }
    const original = structuredClone(params)
    expect(readAcpSessionEvent(params)).toEqual({ kind: 'known', notification: original })
    expect(params).toEqual(original)
  })

  it.each([
    { sessionUpdate: 'vendor_usage', tokens: 1 },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 42 } }
  ])('keeps unknown and malformed known updates for the dialect (%j)', (update) => {
    const params = { sessionId: 'session-1', update, vendor: true }
    expect(readAcpSessionEvent(params)).toEqual({
      kind: 'unrecognized',
      sessionId: 'session-1',
      raw: params
    })
  })

  it.each([null, {}, { sessionId: 'session-1', update: {} }])(
    'rejects malformed notification envelopes (%j)',
    (params) => expect(readAcpSessionEvent(params)).toBeNull()
  )
})
