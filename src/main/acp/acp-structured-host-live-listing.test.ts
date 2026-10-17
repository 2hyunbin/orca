// A Grok chat's start saves its model list to the account's catalog, so the next chat opens warm
// even when a session-free listing failed; its later reads save nothing.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { AgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { openAttachedHostRig } from './acp-structured-host.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

describe('a live Grok listing', () => {
  it('is saved at the start, and a later options read saves nothing', async () => {
    const modelCatalog: AgentModelCatalogService = {
      read: vi.fn(async () => ({ origin: 'unknown' as const })),
      recordLiveListing: vi.fn(),
      prewarm: vi.fn(async () => {}),
      stop: vi.fn(),
      providerStarted: vi.fn()
    }
    const { host } = await openAttachedHostRig({}, undefined, modelCatalog)

    // A running child may run an older CLI than the next start, so only its start speaks.
    expect(modelCatalog.recordLiveListing).toHaveBeenCalledTimes(1)
    await host.readOptions(SESSION)

    expect(modelCatalog.recordLiveListing).toHaveBeenCalledTimes(1)
  })

  it('starts the chat even when saving its start listing throws', async () => {
    const modelCatalog: AgentModelCatalogService = {
      read: vi.fn(async () => ({ origin: 'unknown' as const })),
      recordLiveListing: vi.fn(() => {
        throw new Error('catalog unavailable')
      }),
      prewarm: vi.fn(async () => {}),
      stop: vi.fn(),
      providerStarted: vi.fn()
    }
    // The rig's attach must succeed: bookkeeping never fails a proven start.
    const { store } = await openAttachedHostRig({}, undefined, modelCatalog)
    expect(modelCatalog.recordLiveListing).toHaveBeenCalledTimes(1)
    expect(store.getRecord(SESSION)?.lease.ownerProcess).not.toBeNull()
  })
})
