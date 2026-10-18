import { recordProviderChildEnd } from '../native-chat/agent-session-wire/structured-agent-session-provider-child'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { AgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { CALLER } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { attachParams, openHostRig, openAttachedHostRig } from './acp-structured-host.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

describe('a live Grok listing', () => {
  it('publishes whole startup and read snapshots until the child ends', async () => {
    const modelCatalog: AgentModelCatalogService = {
      read: vi.fn(async () => ({ origin: 'unknown' as const })),
      peek: () => null,
      retainedLiveModelIds: vi.fn(() => []),
      recordLiveListing: vi.fn(),
      prewarm: vi.fn(async () => {}),
      stop: vi.fn(),
      providerStarted: vi.fn()
    }
    const { host } = await openHostRig({ modelCatalog })
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })

    // Its start was saved once as the chat attached; this read is saved too.
    expect(modelCatalog.recordLiveListing).toHaveBeenCalledTimes(1)
    expect(vi.mocked(modelCatalog.recordLiveListing).mock.calls[0]![1].configuredDefault).toEqual({
      modelId: 'grok-4.7',
      effort: 'high'
    })
    await host.readOptions(SESSION)

    expect(modelCatalog.recordLiveListing).toHaveBeenCalledTimes(2)
    const [sessionId, listing] = vi.mocked(modelCatalog.recordLiveListing).mock.calls[1]!
    expect(sessionId).toBe(SESSION)
    expect(listing.models.map((model) => model.id)).toEqual(['grok-4.7', 'grok-4.6'])
    // Current rows do not become defaults; startup configuration stays separate.
    expect(listing.models.every((model) => !model.isDefault)).toBe(true)
    expect(listing).not.toHaveProperty('configuredDefault')
    const conversation = host.collaboratorsForTests().sessions.get(SESSION)!
    const child = conversation.child!
    const ended = { ...child, cause: 'exit' as const, reason: null, duringStartup: false }
    recordProviderChildEnd(conversation, { ...ended, rootGone: true })
    await host.readOptions(SESSION)
    expect(modelCatalog.recordLiveListing).toHaveBeenCalledTimes(2)
  })

  it('starts the chat even when saving its start listing throws', async () => {
    const modelCatalog: AgentModelCatalogService = {
      read: vi.fn(async () => ({ origin: 'unknown' as const })),
      peek: () => null,
      retainedLiveModelIds: vi.fn(() => []),
      recordLiveListing: vi.fn().mockImplementationOnce(() => {
        throw new Error('catalog unavailable')
      }),
      prewarm: vi.fn(async () => {}),
      stop: vi.fn(),
      providerStarted: vi.fn()
    }
    // The rig's attach must succeed: bookkeeping never fails a proven start.
    const { host, store } = await openAttachedHostRig({}, undefined, modelCatalog)
    expect(modelCatalog.recordLiveListing).toHaveBeenCalledTimes(1)
    expect(store.getRecord(SESSION)?.lease.ownerProcess).not.toBeNull()
    await expect(host.readOptions(SESSION)).resolves.toHaveProperty('models')
    expect(modelCatalog.recordLiveListing).toHaveBeenCalledTimes(2)
  })
})
