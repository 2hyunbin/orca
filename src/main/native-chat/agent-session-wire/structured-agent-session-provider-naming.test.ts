import { expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionConversationNaming } from './structured-agent-session-host-types'
import {
  createStructuredAgentSessionProviderNaming,
  withProviderNaming
} from './structured-agent-session-provider-naming'

type Rename = NonNullable<StructuredAgentSessionAdapter['renameProviderSession']>

function chat(fields: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return agentSessionRecordFixture({
    sessionId: 'chat-1',
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/work/.codex' },
    providerHandleChain: [
      {
        linkId: 'link-1',
        handle: codexProviderHandle('thread-1'),
        origin: 'created',
        mintedAtFence: 1,
        observedAt: 0
      }
    ],
    conversationName: 'Release notes',
    conversationNameSource: 'user',
    ...fields
  })
}

function naming(record: () => AgentSessionRecord | null, rename: Rename) {
  const warn = vi.fn()
  const queue = createStructuredAgentSessionProviderNaming({
    store: { getRecord: () => record() },
    adapter: { renameProviderSession: rename },
    logger: { warn, error: vi.fn() }
  })
  return { queue, warn }
}

it("never pushes a name Orca chose, or one for a chat that hasn't started its agent", async () => {
  const rename = vi.fn<Rename>(async () => {})
  let record = chat({ conversationNameSource: undefined })
  const { queue } = naming(() => record, rename)

  await queue.push('chat-1')
  record = chat({ providerHandleChain: [] })
  await queue.push('chat-1')

  expect(rename).not.toHaveBeenCalled()
})

it.each([10, 100])('coalesces %i saved renames into two ordered pushes', async (count) => {
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const rename = vi.fn<Rename>(() => gates[rename.mock.calls.length - 1]!.promise)
  let record = chat({ conversationName: 'First' })
  const { queue } = naming(() => record, rename)
  const setUserName = vi.fn<StructuredAgentSessionConversationNaming['setUserName']>(
    async (_id, name) => {
      record = chat({ conversationName: name })
      return { name, applied: true }
    }
  )
  const wrapped = withProviderNaming(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only setUserName is invoked; other members pass through.
    { setUserName } as unknown as StructuredAgentSessionConversationNaming,
    (id) => void queue.push(id)
  )
  await wrapped.setUserName('chat-1', 'First', 'rename')
  for (let i = 1; i <= count; i += 1) {
    await wrapped.setUserName('chat-1', `Name ${i}`, 'legacy-alias')
  }
  expect(rename).toHaveBeenCalledTimes(1)
  const done = queue.push('chat-1')
  gates[0]!.resolve()
  await vi.waitFor(() => expect(rename).toHaveBeenCalledTimes(2))
  gates[1]!.resolve()
  await done
  expect(rename.mock.calls.map(([input]) => input.name)).toEqual(['First', `Name ${count}`])
  setUserName.mockResolvedValueOnce({ name: record.conversationName ?? '', applied: false })
  await wrapped.setUserName('chat-1', 'Ignored alias', 'legacy-alias')
  expect(rename).toHaveBeenCalledTimes(2)
})

it('logs a failed push and still takes the next rename', async () => {
  const rename = vi
    .fn<Rename>()
    .mockRejectedValueOnce(new Error('thread not found'))
    .mockResolvedValue(undefined)
  const { queue, warn } = naming(() => chat(), rename)

  await queue.push('chat-1')
  await queue.push('chat-1')

  expect(warn).toHaveBeenCalledTimes(1)
  expect(rename).toHaveBeenCalledTimes(2)
})
