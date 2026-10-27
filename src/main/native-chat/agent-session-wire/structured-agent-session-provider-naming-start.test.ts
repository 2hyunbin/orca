import { expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD
} from './structured-agent-session-host-test-data'
import {
  CALLER,
  adapter,
  attach,
  ensureParams,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'

it('names a new agent conversation when it starts, but not one the chat resumes', async () => {
  const prior = hostTestState()
  // Production adapters learn the conversation from open, not from spawning.
  prior.acquire.mockImplementation(async ({ spawnToken }) => ({
    acquisitionGeneration: globalThis.crypto.randomUUID(),
    process: { hostId: 'local', pid: 4242, processStartTimeMs: HOST_TEST_NOW, spawnToken }
  }))
  const base = adapter()
  const nameProviderConversation = vi.fn()
  let opened = 0
  const host = new StructuredAgentSessionHost({
    ...prior.host.deps,
    nameProviderConversation,
    adapter: {
      ...base,
      open: async ({ fence }) => {
        opened += 1
        return {
          reportedOptions: { model: '' },
          link: {
            linkId: `open-${fence}`,
            handle: codexProviderHandle(HOST_TEST_THREAD),
            origin: opened === 1 ? 'created' : 'resumed',
            mintedAtFence: fence,
            observedAt: HOST_TEST_NOW
          }
        }
      }
    }
  })
  replaceHostTestState({ store: prior.store, host })

  await attach()
  await vi.waitFor(() => expect(nameProviderConversation).toHaveBeenCalledWith(HOST_TEST_SESSION))

  await host.close(HOST_TEST_SESSION, 'evict')
  const record = prior.store.getRecord(HOST_TEST_SESSION)
  if (!record) {
    throw new Error('the chat was not saved')
  }
  expect((await host.attach(CALLER, ensureParams(record.lease.runtimeFence))).ok).toBe(true)
  await vi.waitFor(() => expect(opened).toBe(2))
  await host.flushAllStreamedEvents()

  expect(nameProviderConversation).toHaveBeenCalledTimes(1)
})
