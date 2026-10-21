import { afterEach, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionStatusSubscriber } from '../../../native-chat/agent-session-wire/structured-agent-session-status-feed'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { agentSessionRecordFixture } from '../../../../shared/agent-session-record.test-fixture'
import {
  call,
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

afterEach(clearStructuredHostStub)

it('refuses a rename when its durable record is missing', async () => {
  installStructuredHostStub()
  hostCalls.setUserConversationName = vi.fn(async () => null)
  expect(
    await call('agentSession.rename', { sessionId: SESSION, name: 'Only name' }, STRUCTURED_CLIENT)
  ).toMatchObject({ ok: false })
})

it('filters naming notes by the same record audience as status rows', async () => {
  installStructuredHostStub()
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('Missing test host')
  }
  vi.spyOn(host.deps.store, 'getRecord').mockImplementation((sessionId: string) =>
    sessionId === 'missing'
      ? null
      : { ...agentSessionRecordFixture(), provider: sessionId === 'pi' ? 'pi' : 'codex' }
  )
  hostCalls.subscribeStatus.mockImplementation(
    (subscriber: StructuredAgentSessionStatusSubscriber) => {
      subscriber.emit({
        type: 'snapshot',
        sessions: [],
        conversationNames: ['codex', 'pi', 'missing'].map((sessionId) => ({
          sessionId,
          conversationName: 'Name'
        }))
      })
      return () => {}
    }
  )
  expect(await call('agentSession.subscribeStatus', null, STRUCTURED_CLIENT)).toMatchObject({
    result: { conversationNames: [{ sessionId: 'codex', conversationName: 'Name' }] }
  })
})
