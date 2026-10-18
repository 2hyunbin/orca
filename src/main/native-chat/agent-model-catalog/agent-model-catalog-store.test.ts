import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  AgentModelCatalogStore,
  AGENT_MODEL_CATALOG_FRESH_MS,
  AGENT_MODEL_CATALOG_FAILURE_TTL_MS,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'
import { createAgentModelCatalogFilePersistence } from './agent-model-catalog-persistence'
import { agentModelCatalogResultFromEntry } from './agent-model-catalog-entry'

const listing = (id = 'opus'): AgentModelCatalogSuccess => ({
  origin: 'probe',
  complete: true,
  models: [{ id, label: id, isDefault: true, efforts: [] }],
  configured: { model: id, effort: 'high' }
})

it.each(['claude', 'grok', 'pi'])('restores schema-3 %s sources', async (agent) => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-catalog-migration-'))
  const persistence = createAgentModelCatalogFilePersistence(directory)
  try {
    for (const [probeAt, liveAt, expected] of [
      [20, 10, 'probe'],
      [10, 20, 'live'],
      [20, 20, 'probe']
    ] as const) {
      const observation = (id: string, at: number) => ({
        ...listing(id),
        at,
        configured: undefined,
        models: [{ id, label: id, isDefault: false, efforts: [] }]
      })
      await writeFile(
        join(directory, 'agent-model-catalog.json'),
        JSON.stringify({
          version: 3,
          entries: [
            {
              agent,
              fingerprint: 'legacy',
              discovered: observation('probe', probeAt),
              live: observation('live', liveAt),
              configured: { modelId: 'probe', sameModelIds: ['live'], effort: 'high', at: 5 }
            }
          ]
        })
      )
      const store = new AgentModelCatalogStore({ now: () => 100 })
      await store.attachPersistence(persistence)
      const entry = store.get('legacy')!
      const currentId = agent === 'claude' ? expected : liveAt >= probeAt ? 'live' : 'probe'
      expect(entry.models.map((row) => row.id)).toEqual([currentId])
      expect(entry.models[0]?.efforts).toEqual([])
      expect(entry.observation?.configured ?? entry.configured).toEqual(
        agent === 'claude'
          ? { model: 'probe', effort: 'high', at: 5 }
          : { modelId: 'probe', sameModelIds: ['live'], effort: 'high', at: 5 }
      )
      if (agent !== 'claude') {
        expect(entry.discovered?.models[0]?.effortsKnown).toBe(false)
        expect(entry.live?.at).toBe(liveAt)
      }
      expect(agentModelCatalogResultFromEntry(entry, true, true).models[0]?.isDefault).toBe(
        currentId === 'probe'
      )
      expect(store.shouldRefresh('legacy')).toBe(agent === 'claude')
      persistence.save([entry])
      await persistence.flush()
      const loaded = new AgentModelCatalogStore({ now: () => 100 })
      await loaded.attachPersistence(persistence)
      expect(loaded.get('legacy')?.observation).toEqual(entry.observation)
      expect(loaded.get('legacy')).toEqual(entry)
      expect(loaded.freshForMs(loaded.get('legacy')!)).toBe(0)
      expect(loaded.shouldRefresh('legacy')).toBe(agent === 'claude')
      if (agent !== 'claude') {
        loaded.recordConfiguredDefault('legacy', { modelId: 'probe', sameModelIds: ['live'] })
        expect(loaded.get('legacy')?.configured?.effort).toBe('high')
        loaded.recordConfiguredDefault('legacy', { modelId: 'probe', effort: null })
        expect(loaded.get('legacy')?.configured).toEqual({ modelId: 'probe', at: 100 })
        loaded.recordConfiguredDefault('legacy', null)
        expect(loaded.get('legacy')?.configured).toBeNull()
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('invalidates absence evidence after a discovery refresh fails', async () => {
  let now = 10
  const store = new AgentModelCatalogStore({ now: () => now })
  const entry = store.recordSuccess('scope', 'claude', listing(), 'discovery')!
  expect(store.freshForMs(entry)).toBe(AGENT_MODEL_CATALOG_FRESH_MS)
  await store.refresh(
    'scope',
    'claude',
    async () => listing(),
    async () => {
      throw new Error('offline')
    }
  )
  now += AGENT_MODEL_CATALOG_FAILURE_TTL_MS
  expect(store.get('scope')?.models).toEqual(entry.models)
  expect(store.freshForMs(entry)).toBe(0)
  store.recordSuccess('acp', 'grok', listing(), 'discovery')
  now += 10 * 60_000
  store.recordSuccess('acp', 'grok', listing(), 'live')
  expect(store.shouldRefresh('acp')).toBe(true)
})
