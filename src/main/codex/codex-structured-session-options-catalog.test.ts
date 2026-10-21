import { projectCodexSessionOptions } from './codex-structured-service-tier'
import {
  applyCodexStructuredSessionOption,
  readLiveCodexSessionOptions,
  prepareLiveCodexSessionOptions
} from './codex-structured-session-options'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { optionSession } from './codex-structured-option-session.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { fetchCodexModelCatalogListing } from './codex-structured-model-catalog'

function modelRow(id: string): Record<string, unknown> {
  return {
    model: id,
    displayName: id.toUpperCase(),
    supportedReasoningEfforts: [{ reasoningEffort: 'high' }]
  }
}

describe('first-turn catalog deadline', () => {
  it('budgets all pages and config/read against one 30-second deadline', async () => {
    let now = 1_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const timeouts: number[] = []
    const request = vi.fn(
      async (
        method: string,
        _params?: Record<string, unknown>,
        options?: { timeoutMs?: number | null }
      ) => {
        timeouts.push(options?.timeoutMs ?? 0)
        if (method === 'model/list') {
          now += 15_001
          return { data: [modelRow('gpt-live')], nextCursor: timeouts.length === 1 ? 'more' : null }
        }
        return { config: {} }
      }
    )
    try {
      await expect(
        fetchCodexModelCatalogListing({ connection: { request }, deadlineMs: 30_000 })
      ).rejects.toThrow('deadline exceeded')
      expect(request.mock.calls.map(([method]) => method)).toEqual(['model/list', 'model/list'])
      expect(timeouts).toEqual([30_000, 14_999])
    } finally {
      clock.mockRestore()
    }
  })
})

it('uses real child A controls with production access to B and rejects predecessor replies', async () => {
  let efforts: { reasoningEffort: string }[] | undefined = [
    { reasoningEffort: 'low' },
    { reasoningEffort: 'high' }
  ]
  let tiers: string[] | undefined = ['fast']
  const request = vi.fn(async (_method: string) => ({
    data: [
      {
        model: 'A',
        ...(tiers ? { additionalSpeedTiers: tiers } : {}),
        ...(efforts ? { supportedReasoningEfforts: efforts } : {})
      }
    ],
    nextCursor: null
  }))
  const session = optionSession(request)
  session.options = new Map([
    ['model', 'A'],
    ['effort', 'high']
  ])
  const store = new AgentModelCatalogStore()
  store.recordSuccess(
    'scope',
    'codex',
    {
      origin: 'probe',
      complete: true,
      models: [{ id: 'B', label: 'B', efforts: [], isDefault: true }]
    },
    'discovery'
  )
  session.catalogAccess = {
    store,
    fingerprint: 'scope',
    accountHomePath: '/account',
    read: (verified) => {
      const entry = store.get('scope')
      return entry && (!verified || store.verified(entry)) ? entry : null
    },
    demand: async () => {}
  }
  expect(
    (await readLiveCodexSessionOptions(session, 100)).models.find((row) => row.id === 'A')?.efforts
  ).toEqual([
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' }
  ])
  await expect(applyCodexStructuredSessionOption(session, 'effort', 'low')).resolves.toMatchObject({
    effort: 'low'
  })
  session.options.set('serviceTier', 'fast')
  expect((await readLiveCodexSessionOptions(session, 100)).current.serviceTier).toBe('fast')
  expect(
    projectCodexSessionOptions(session, Object.fromEntries(session.options))?.options.serviceTier
  ).toBe('fast')
  request.mockRejectedValueOnce(new Error('unavailable'))
  expect(
    (await readLiveCodexSessionOptions(session, 100)).models.find((row) => row.id === 'A')
      ?.serviceTiers
  ).toHaveLength(1)
  tiers = []
  const empty = await readLiveCodexSessionOptions(session, 100)
  expect(empty.models.find((row) => row.id === 'A')).toMatchObject({
    serviceTiers: [],
    supportsFastMode: false
  })
  expect(empty.current.serviceTier).toBe('default')
  expect(
    projectCodexSessionOptions(session, Object.fromEntries(session.options))?.options.serviceTier
  ).toBe('default')
  expect(session.options.get('serviceTier')).toBe('fast')
  tiers = undefined
  expect(store.get('scope')?.models.map((row) => row.id)).toEqual(['B'])
  expect(request.mock.calls.every((args) => args[0] === 'model/list')).toBe(true)
  efforts = undefined
  await readLiveCodexSessionOptions(session, 100)
  await expect(applyCodexStructuredSessionOption(session, 'effort', 'high')).resolves.toMatchObject(
    {
      effort: 'high'
    }
  )
  efforts = []
  await readLiveCodexSessionOptions(session, 100)
  await expect(applyCodexStructuredSessionOption(session, 'effort', 'low')).rejects.toThrow(
    'does not support low'
  )
  expect(session.options.get('effort')).toBe('high')
  const late = await prepareLiveCodexSessionOptions(session, 100)
  session.fence += 1
  expect(late().models.find((row) => row.id === 'A')?.effortsKnown).toBe(false)
  efforts = [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }]
  const predecessorReply = await request('model/list')
  const pending = Promise.withResolvers<typeof predecessorReply>()
  request.mockImplementationOnce(() => pending.promise)
  const reading = prepareLiveCodexSessionOptions(session, 100)
  session.connection = optionSession(request).connection
  pending.resolve(predecessorReply)
  expect((await reading)().models.find((row) => row.id === 'A')?.effortsKnown).toBe(false)
  expect(
    (await readLiveCodexSessionOptions(session, 100)).models.find((row) => row.id === 'A')?.efforts
  ).toEqual([
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' }
  ])
  store.recordSuccess(
    'scope',
    'codex',
    {
      origin: 'probe',
      complete: true,
      models: [
        {
          id: 'A',
          label: 'Installed A',
          efforts: [{ value: 'high', label: 'High' }],
          defaultEffort: 'high',
          serviceTiers: [{ value: 'fast', label: 'Fast' }],
          supportsFastMode: true
        }
      ]
    },
    'discovery'
  )
  efforts = undefined
  const partial = await readLiveCodexSessionOptions(session, 100)
  expect(partial.models.find((row) => row.id === 'A')).toMatchObject({
    efforts: [{ value: 'high', label: 'High' }],
    defaultEffort: 'high',
    serviceTiers: [{ value: 'fast', label: 'Fast' }],
    supportsFastMode: true
  })
  efforts = []
  tiers = []
  const explicit = await readLiveCodexSessionOptions(session, 100)
  expect(explicit.models.find((row) => row.id === 'A')).toMatchObject({
    efforts: [],
    serviceTiers: [],
    supportsFastMode: false
  })
  expect(explicit.models.find((row) => row.id === 'A')?.defaultEffort).toBeUndefined()
})
