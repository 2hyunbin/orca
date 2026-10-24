import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'
import {
  agentModelCatalogCodec,
  createAgentModelCatalogFilePersistence
} from './agent-model-catalog-persistence'
import { attachAgentModelCatalogPersistenceOnce } from '../../runtime/structured-agent-model-catalog-wiring'
import {
  AgentModelCatalogStore,
  agentModelCatalogStore,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'

vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof files>()) }))

function models(...ids: string[]): AgentSessionModelOption[] {
  return ids.map((id, index) => ({
    id,
    label: id.toUpperCase(),
    isDefault: index === 0,
    efforts: [{ value: 'high', label: 'High' }]
  }))
}

function success(...ids: string[]): AgentModelCatalogSuccess {
  return {
    models: models(...ids),
    origin: 'live-session'
  }
}

/** A live session's per-spawn handle; each call is a distinct lister. */
describe('agent model catalog file persistence', () => {
  it('imports complete schema3 sources only after hydration, with current entries and retention winning', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-import-'))
    let at = 3
    const seed = new AgentModelCatalogStore({ now: () => at++ })
    const graph = models('disk', 'other').map((model) => ({
      ...model,
      description: 'description',
      resolvedModel: `provider/${model.id}`,
      defaultEffort: 'high',
      efforts: model.efforts.map((choice) => ({ ...choice, description: 'effort description' })),
      supportsFastMode: false,
      supportsAutoMode: true,
      serviceTiers: [],
      effortsKnown: false as const
    }))
    for (let i = 0; i < 253; i++) {
      const variant =
        i === 248
          ? models('distinct')
          : i === 249
            ? graph.toReversed()
            : i === 250
              ? graph.map((row) => ({ ...row, description: 'near equal' }))
              : structuredClone(graph)
      const source = {
        ...success('disk'),
        models: variant,
        fastModeSupport: { supported: i % 2 === 0, reason: String(i) }
      }
      seed.recordSuccess(`fp-${i}`, 'grok', source, 'discovery')
    }
    seed.recordSuccess('fp-251', 'grok', success('live', 'chosen'), 'live')
    seed.recordConfiguredDefault('fp-251', {
      modelId: 'chosen',
      sameModelIds: ['alias'],
      effort: 'high'
    })
    const rows = Array.from({ length: 253 }, (_, i) => seed.get(`fp-${i}`)!)
    for (const agent of ['claude', 'codex']) {
      seed.recordSuccess(agent, agent, { ...success('display'), complete: true }, 'discovery')
      const entry = seed.get(agent)!
      rows.push({ ...entry, discovered: null, live: entry.discovered })
    }
    const legacy = join(directory, 'agent-model-catalog.json')
    const bytes = `{"version":2,"entries":[null],"padding":${JSON.stringify('🧭'.repeat(18_000))},"version":3,"entries":${JSON.stringify([...rows, { ...rows[0], live: rows[251]!.live }])}}`
    writeFileSync(legacy, bytes)
    const store = new AgentModelCatalogStore()
    const persistence = createAgentModelCatalogFilePersistence(directory)
    store.recordSuccess('fp-252', 'grok', success('current'), 'live')
    const loading = store.attachPersistence(persistence)
    store.recordSuccess('new', 'grok', success('during'), 'discovery')
    const flushing = store.flushPersistence()
    await Promise.all([loading, flushing])
    const loaded = await persistence.load()
    expect(loaded).toHaveLength(256)
    expect(loaded.find((row) => row.fingerprint === 'fp-252')?.live?.models[0]?.id).toBe('current')
    expect(loaded.find((row) => row.fingerprint === 'new')?.models[0]?.id).toBe('during')
    for (const agent of ['claude', 'codex']) {
      expect(loaded.find((row) => row.agent === agent)).toMatchObject({
        live: null,
        configured: null,
        discovered: { models: [{ id: 'display' }] }
      })
    }
    expect(loaded.find((row) => row.fingerprint === 'fp-0')?.live).toBeNull()
    expect(loaded.find((row) => row.fingerprint === 'fp-251')).toMatchObject({
      discovered: { models: [{ id: 'disk' }, { id: 'other' }] },
      live: { models: [{ id: 'live' }, { id: 'chosen' }] },
      configured: { modelId: 'chosen', effort: 'high' }
    })
    expect(JSON.parse(readFileSync(legacy, 'utf8')).version).toBe(4)
    store.get('fp-252')
    store.recordSuccess('extra', 'grok', success('extra'), 'live')
    await store.flushPersistence()
    expect(await persistence.load()).toHaveLength(256)
    expect(store.get('new')).toBeNull()
    const restored = new AgentModelCatalogStore()
    await restored.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    expect(restored.get('fp-251')?.configured?.modelId).toBe('chosen')
    const document = JSON.parse(readFileSync(legacy, 'utf8'))
    expect(document.entries.filter(([tag]: [string, unknown]) => tag === 'models')).toHaveLength(8)
    for (const index of [248, 249, 250, 251]) {
      expect(loaded.find((entry) => entry.fingerprint === `fp-${index}`)).toEqual(rows[index])
    }
    const scope = document.entries.find(([tag]: [string, unknown]) => tag === 'scope')[1]
    const dense = models(...Array.from({ length: 401 }, (_, i) => String(i)))
    const records = [
      ['models', dense],
      ['models', graph],
      ['models', graph],
      ...Array.from({ length: 100 }, (_, i) => ['scope', { ...scope, fingerprint: String(i) }])
    ]
    const compact = `{"version":3,"entries":[["models",null]],"entries":${JSON.stringify(records)},"version":4}`
    expect(Buffer.byteLength(compact)).toBeLessThan(64 * 1024)
    writeFileSync(legacy, compact)
    const parse = agentModelCatalogCodec.parseEntry
    let yielded = true
    const parsing = vi.spyOn(agentModelCatalogCodec, 'parseEntry').mockImplementation((...args) => {
      expect(yielded).toBe(true)
      yielded = false
      setImmediate(() => {
        yielded = true
      })
      return parse(...args)
    })
    const expanded = await persistence.load()
    expect(expanded).toHaveLength(100)
    expect(expanded[0]?.models).toHaveLength(401)
    expect(parsing).toHaveBeenCalledTimes(100)
    parsing.mockRestore()
    writeFileSync(
      legacy,
      `{"version":4,"entries":[["wrong",null]],"version":3,"entries":${JSON.stringify([store.get('fp-251')])}}`
    )
    expect(await persistence.load()).toEqual([store.get('fp-251')])
    rmSync(directory, { recursive: true, force: true })
  })

  it.each([
    [10, false],
    [100, false],
    [10, true],
    [100, true]
  ] as const)(
    'streams %i changes (distinct=%s) with backpressure and joined flush',
    async (count, distinct) => {
      const directory = mkdtempSync(join(tmpdir(), 'catalog-stream-'))
      let at = 1_000
      const store = new AgentModelCatalogStore({ now: () => at })
      const persistence = createAgentModelCatalogFilePersistence(directory)
      await store.attachPersistence(persistence)
      const scans = vi.fn<Parameters<typeof persistence.save>[0]>()
      const save = persistence.save
      vi.spyOn(persistence, 'save').mockImplementation((source) => {
        scans.mockImplementation(source)
        save(scans)
      })
      const { promise: held, resolve: holding } = Promise.withResolvers<void>()
      const { promise: released, resolve: release } = Promise.withResolvers<void>()
      const open = files.open
      const opening = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args)
        const write = handle.writeFile.bind(handle)
        vi.spyOn(handle, 'writeFile').mockImplementation(async (data, options) => {
          if (opening.mock.calls.length === 1 && String(data).includes('"fingerprint":"fp-0"')) {
            holding()
            await released
          }
          return write(data, options)
        })
        return handle
      })
      const publishing = vi.spyOn(files, 'rename')
      for (let i = 0; i < count; i++) {
        store.recordSuccess(
          `fp-${i}`,
          'grok',
          success(distinct ? `model-${i}` : 'model', 'chosen'),
          'live'
        )
      }
      expect(opening).not.toHaveBeenCalled()
      expect(scans).not.toHaveBeenCalled()
      const canonical = vi.spyOn(agentModelCatalogCodec, 'parseModels')
      const encoded = vi.spyOn(JSON, 'stringify')
      const payloads = () =>
        encoded.mock.calls.filter(([value]) => Array.isArray(value) && value[0] === 'scope')
      const graphEncodes = () =>
        encoded.mock.calls.filter(
          ([value]) =>
            Array.isArray(value) &&
            value[0] !== null &&
            typeof value[0] === 'object' &&
            Object.hasOwn(value[0], 'id')
        )
      const comparing = vi.spyOn(Map.prototype, 'get')
      const comparisons = () =>
        comparing.mock.calls.filter(([key]) => typeof key === 'string' && key.startsWith('[{"id":'))
      const first = store.flushPersistence()
      await held
      expect(payloads()).toHaveLength(1)
      at++
      for (let i = 0; i < count; i++) {
        store.recordSuccess(
          `fp-${i}`,
          'grok',
          success(distinct ? `new-${i}` : 'new', 'chosen'),
          'live'
        )
      }
      store.recordConfiguredDefault('fp-0', { modelId: 'chosen' })
      store.recordSuccess('extra', 'grok', success('extra'), 'live')
      expect(store.flushPersistence()).toBe(first)
      expect(opening).toHaveBeenCalledTimes(1)
      expect(payloads()).toHaveLength(1)
      release()
      await first
      expect(payloads()).toHaveLength(count * 2 + 1)
      expect(canonical).toHaveBeenCalledTimes(count * 2 + 1)
      expect(opening).toHaveBeenCalledTimes(2)
      expect(publishing).toHaveBeenCalledTimes(2)
      // Unchanged reports still replace age; get() reorders without a save notification.
      at++
      store.recordSuccess('fp-1', 'grok', success(distinct ? 'new-1' : 'new', 'chosen'), 'live')
      store.get('fp-0')
      await store.flushPersistence()
      expect(payloads()).toHaveLength(count * 3 + 2)
      expect(canonical).toHaveBeenCalledTimes(count * 2 + 1)
      expect(graphEncodes()).toHaveLength(count * 4 + 3)
      expect(comparisons()).toHaveLength(count * 3 + 2)
      expect(
        JSON.parse(
          readFileSync(join(directory, 'agent-model-catalog.json'), 'utf8')
        ).entries.filter(([tag]: [string, unknown]) => tag === 'models')
      ).toHaveLength(distinct ? count + 1 : 2)
      expect(scans.mock.calls.length).toBeLessThanOrEqual(7)
      const loaded = await persistence.load()
      expect(loaded.at(-1)?.fingerprint).toBe('fp-0')
      expect(loaded.find((row) => row.fingerprint === 'fp-1')?.live?.at).toBe(at)
      expect(loaded.at(-1)?.configured?.modelId).toBe('chosen')
      vi.restoreAllMocks()
      rmSync(directory, { recursive: true, force: true })
    }
  )
  it('paces normal starts at 500ms and keeps changes during an active write owed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-cadence-'))
    const store = new AgentModelCatalogStore()
    const persistence = createAgentModelCatalogFilePersistence(directory)
    await store.attachPersistence(persistence)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const started = Date.now()
    const starts: number[] = []
    const open = files.open
    vi.spyOn(files, 'open').mockImplementation((...args) => {
      starts.push(Date.now())
      return open(...args)
    })
    const rename = files.rename
    const { promise: committed, resolve: firstCommitted } = Promise.withResolvers<void>()
    vi.spyOn(files, 'rename').mockImplementation(async (...args) => {
      await rename(...args)
      if (starts.length === 1) {
        store.recordSuccess('newer', 'grok', success('newer'), 'live')
        firstCommitted()
      }
    })
    try {
      store.recordSuccess('first', 'grok', success('first'), 'live')
      await vi.advanceTimersByTimeAsync(499)
      expect(starts).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await committed
      await persistence.load()
      await vi.advanceTimersByTimeAsync(499)
      expect(starts).toEqual([started + 500])
      await vi.advanceTimersByTimeAsync(1)
      await store.flushPersistence()
      expect(starts).toEqual([started + 500, started + 1_000])
      expect((await persistence.load()).map((row) => row.fingerprint)).toEqual(['first', 'newer'])
    } finally {
      vi.restoreAllMocks()
      vi.useRealTimers()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it.each(['encode', 'write', 'close', 'rename', 'uncertain', 'uncertain-revert', 'retire'])(
    'preserves complete authority and latest retry after %s failure',
    async (stage) => {
      const directory = mkdtempSync(join(tmpdir(), 'catalog-publication-'))
      const path = join(directory, 'agent-model-catalog.json')
      const seed = new AgentModelCatalogStore()
      const kept = seed.recordSuccess('kept', 'grok', success('kept'), 'discovery')!
      const old = seed.recordSuccess('old', 'grok', success('old'), 'discovery')!
      writeFileSync(path, JSON.stringify({ version: 3, entries: [kept, old] }))
      let source = new Map([kept, old].map((row) => [row.fingerprint, row]))
      const persistence = createAgentModelCatalogFilePersistence(directory)
      await persistence.attach!(() => source.values(), vi.fn())
      await persistence.flush()
      const bytes = readFileSync(path, 'utf8')
      seed.recordConfiguredDefault('old', { modelId: 'old', effort: 'high' })
      source.set('old', seed.get('old')!)
      source.delete('kept')
      source.set('new', seed.recordSuccess('new', 'grok', success('new'), 'live')!)
      const attempted = [...source.values()]
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      if (stage === 'encode') {
        vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
          throw new Error(stage)
        })
      }
      const open = files.open
      const closing = vi.fn<() => Promise<void>>()
      const opening = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args)
        const close = handle.close.bind(handle)
        closing.mockImplementation(async () => {
          if (stage === 'retire' || (stage === 'close' && closing.mock.calls.length === 1)) {
            throw new Error(stage)
          }
          await close()
        })
        vi.spyOn(handle, 'close').mockImplementation(closing)
        const write = handle.writeFile.bind(handle)
        vi.spyOn(handle, 'writeFile').mockImplementation(async (data, options) => {
          if (typeof data === 'string' && data.includes('"fingerprint":"old"')) {
            source = new Map([['kept', kept]])
            source.set('old', stage.endsWith('revert') ? old : seed.get('old')!)
            if (stage === 'write' || stage === 'retire') {
              throw new Error(stage)
            }
          }
          return write(data, options)
        })
        return handle
      })
      const rename = files.rename
      vi.spyOn(files, 'rename').mockImplementation(async (...args) => {
        if (stage.startsWith('uncertain')) {
          await rename(...args)
        }
        throw new Error(stage)
      })
      persistence.save(() => source.values())
      await persistence.flush()
      expect(warn).toHaveBeenCalledTimes(1)
      if (stage === 'retire') {
        await persistence.flush()
        expect(opening).toHaveBeenCalledTimes(1)
        expect(closing).toHaveBeenCalledTimes(2)
      }
      const published = await createAgentModelCatalogFilePersistence(directory).load()
      expect(published).toEqual(stage.startsWith('uncertain') ? attempted : [kept, old])
      if (!stage.startsWith('uncertain')) {
        expect(readFileSync(path, 'utf8')).toBe(bytes)
      }
      await new Promise((resolve) => setTimeout(resolve, 550))
      expect(opening).toHaveBeenCalledTimes(1)
      vi.restoreAllMocks()
      await persistence.flush()
      expect(await persistence.load()).toEqual([...source.values()])
      expect((await files.readdir(directory)).sort()).toEqual(['agent-model-catalog.json'])
      source.clear()
      persistence.save(() => source.values())
      await persistence.flush()
      expect(await createAgentModelCatalogFilePersistence(directory).load()).toEqual([])
      expect(JSON.parse(readFileSync(path, 'utf8')).entries).toEqual([])
      rmSync(directory, { recursive: true, force: true })
    }
  )
  it('retries transient initialization through hydrate end before publishing current memory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-authority-'))
    const path = join(directory, 'agent-model-catalog.json')
    const seed = new AgentModelCatalogStore()
    seed.recordSuccess('disk', 'grok', success('disk'), 'discovery')
    writeFileSync(`${path}.backup`, JSON.stringify({ version: 3, entries: [seed.get('disk')] }))
    mkdirSync(path)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = new AgentModelCatalogStore()
    const persistence = createAgentModelCatalogFilePersistence(directory)
    await store.attachPersistence(persistence)
    store.recordSuccess('memory', 'grok', success('memory'), 'live')
    await store.flushPersistence()
    expect(store.get('disk')).toBeNull()
    expect(store.get('memory')).not.toBeNull()
    rmSync(path, { recursive: true })
    renameSync(`${path}.backup`, path)
    await store.flushPersistence()
    expect(store.get('disk')?.models[0]?.id).toBe('disk')
    expect((await persistence.load()).map((row) => row.fingerprint)).toEqual(['memory', 'disk'])
    warn.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  })
  it.each([
    '{"version":3,"entries":[]} trailing',
    '{"version":3,"entries":[]',
    '{"version":5,"entries":[]}',
    '{"version":3,"entries":[],"entries":{}}',
    ...[
      '{}',
      '{"models":null}',
      '{"models":-1}',
      '{"models":0.5}',
      '{"models":1}',
      '{"models":"0"}',
      '{"models":{}}',
      'definition'
    ].map((live) => {
      const discovered = { models: 0, origin: 'probe', at: 1 }
      const first = JSON.stringify([
        'scope',
        { agent: 'claude', fingerprint: 'duplicate', discovered }
      ])
      const tail =
        live === 'definition'
          ? `${first},["models",[null]]`
          : `["scope",{"agent":"claude","fingerprint":"duplicate","discovered":${JSON.stringify(discovered)},"live":${live}}]`
      return `{"version":4,"entries":[["models",${JSON.stringify(models('m'))}],${first},${tail}]}`
    }),
    ...[
      `[["scope",{"agent":"grok","fingerprint":"forward","live":{"models":0}}],["models",${JSON.stringify(models('m'))}]]`,
      `[["models",${JSON.stringify(models('m'))}],["scope",null],["models",[]]]`,
      '[["wrong",[]]]'
    ].map((entries) => `{"version":4,"entries":${entries}}`)
  ])('preserves an invalid generation without partial hydration or rewrite: %s', async (bytes) => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-framing-'))
    const legacy = join(directory, 'agent-model-catalog.json')
    writeFileSync(legacy, bytes)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = new AgentModelCatalogStore()
    await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    store.recordSuccess('memory', 'grok', success('memory'), 'live')
    await store.flushPersistence()
    expect(store.get('memory')).not.toBeNull()
    expect(store.get('duplicate')).toBeNull()
    expect(warn).toHaveBeenCalled()
    expect(readFileSync(legacy, 'utf8')).toBe(bytes)
    expect(await files.readdir(directory)).toEqual(['agent-model-catalog.json'])
    warn.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  })
  it('keeps the once-attached catalog usable after the runtime journal closes and reinstalls', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-runtime-'))
    const journal = new SyncDatabase(join(directory, 'journal.db'))
    await attachAgentModelCatalogPersistenceOnce(directory)
    journal.close()
    agentModelCatalogStore.recordSuccess('runtime', 'grok', success('first'), 'live')
    await agentModelCatalogStore.flushPersistence()
    await attachAgentModelCatalogPersistenceOnce(join(directory, 'unused'))
    agentModelCatalogStore.recordSuccess('runtime', 'grok', success('reinstalled'), 'live')
    await agentModelCatalogStore.flushPersistence()
    expect((await createAgentModelCatalogFilePersistence(directory).load())[0]?.models[0]?.id).toBe(
      'reinstalled'
    )
    expect(existsSync(join(directory, 'unused'))).toBe(false)
    rmSync(directory, { recursive: true, force: true })
  })
})
