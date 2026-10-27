import { describe, expect, it, vi } from 'vitest'
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

describe('naming the agent conversation after a chat rename', () => {
  it("gives the chat's current agent conversation the user's saved name", async () => {
    const rename = vi.fn<Rename>(async () => {})
    const { queue } = naming(() => chat(), rename)

    await queue.push('chat-1')

    expect(rename).toHaveBeenCalledTimes(1)
    expect(rename.mock.calls[0]?.[0]).toMatchObject({
      providerSessionId: 'thread-1',
      name: 'Release notes'
    })
  })

  it("never pushes a name Orca chose, or one for a chat that hasn't started its agent", async () => {
    const rename = vi.fn<Rename>(async () => {})
    let record = chat({ conversationNameSource: undefined })
    const { queue } = naming(() => record, rename)

    await queue.push('chat-1')
    record = chat({ providerHandleChain: [] })
    await queue.push('chat-1')

    expect(rename).not.toHaveBeenCalled()
  })

  it('lands a burst of renames as the latest name, one push at a time', async () => {
    let release = (): void => {}
    const rename = vi.fn<Rename>(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    let record = chat({ conversationName: 'First' })
    const { queue } = naming(() => record, rename)

    const done = queue.push('chat-1')
    record = chat({ conversationName: 'Second' })
    void queue.push('chat-1')
    record = chat({ conversationName: 'Third' })
    void queue.push('chat-1')
    expect(rename).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(() => expect(rename).toHaveBeenCalledTimes(2))
    release()
    await done

    expect(rename.mock.calls.map(([input]) => input.name)).toEqual(['First', 'Third'])
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

  it('names the agent conversation only after a rename the record took', async () => {
    const nameProvider = vi.fn()
    const setUserName = vi
      .fn<StructuredAgentSessionConversationNaming['setUserName']>()
      .mockResolvedValueOnce({ name: 'Release notes', applied: true })
      .mockResolvedValueOnce({ name: 'Release notes', applied: false })
      .mockResolvedValueOnce(null)
    const wrapped = withProviderNaming(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wrapper reads only setUserName and spreads the rest through untouched.
      { setUserName } as unknown as StructuredAgentSessionConversationNaming,
      nameProvider
    )

    await wrapped.setUserName('chat-1', 'Release notes', 'rename')
    await wrapped.setUserName('chat-1', 'Old tab name', 'legacy-alias')
    await wrapped.setUserName('missing', 'Anything', 'rename')

    expect(nameProvider.mock.calls).toEqual([['chat-1']])
  })
})
