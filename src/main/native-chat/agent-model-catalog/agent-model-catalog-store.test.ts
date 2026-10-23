import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import SyncDatabase from '../../sqlite/sync-database'
import { NodeSqliteStatement } from '../../sqlite/node-sqlite-statement'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogFingerprintForRecord
} from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogFilePersistence } from './agent-model-catalog-persistence'
import { attachAgentModelCatalogPersistenceOnce } from '../../runtime/structured-agent-model-catalog-wiring'
import {
  AGENT_MODEL_CATALOG_FAILURE_TTL_MS,
  AGENT_MODEL_CATALOG_FRESH_MS,
  AGENT_MODEL_CATALOG_MAX_ENTRIES,
  AGENT_MODEL_CATALOG_PICKER_WAIT_MS,
  AgentModelCatalogStore,
  agentModelCatalogStore,
  type AgentModelCatalogProbe,
  type AgentModelCatalogSessionAccess,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'

const sql = SyncDatabase.prototype
const faults = 'row delete commit first rollback close busy'.split(' ')
faults.push('uncertain', 'uncertain-first', 'uncertain-delete-revert', 'uncertain-revert')
const transactions = [10, 100].flatMap((n) => faults.map((stage) => [n, stage] as const))
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
function liveLister(store: AgentModelCatalogStore): AgentModelCatalogSessionAccess {
  return { store, fingerprint: 'fp-1', accountHomePath: '/homes/a' }
}

describe('agent model catalog store', () => {
  it('serves an entry at any age and flags staleness at the refresh threshold', () => {
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    store.recordSuccess('fp-1', 'grok', success('gpt-a'), 'discovery')
    const entry = store.get('fp-1')!
    expect(entry.models.map((model) => model.id)).toEqual(['gpt-a'])
    expect(store.isStale(entry)).toBe(false)
    expect(store.shouldRefresh('fp-1')).toBe(false)
    at += AGENT_MODEL_CATALOG_FRESH_MS
    expect(store.get('fp-1')).not.toBeNull()
    expect(store.shouldRefresh('fp-1')).toBe(true)
  })

  it('never memoizes an empty list as a catalog', () => {
    const store = new AgentModelCatalogStore()
    expect(
      store.recordSuccess(
        'fp-1',
        'grok',
        {
          models: [],
          origin: 'live-session'
        },
        'discovery'
      )
    ).toBeNull()
    expect(store.get('fp-1')).toBeNull()
  })

  it('holds a failure under its TTL without touching the last good entry', () => {
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    store.recordSuccess('fp-1', 'grok', success('gpt-a'), 'discovery')
    store.recordFailure('fp-1', 'timed out')
    expect(store.get('fp-1')!.models.map((model) => model.id)).toEqual(['gpt-a'])
    expect(store.hasActiveFailure('fp-1')).toBe(true)
    expect(store.failureDetail('fp-1')).toBe('timed out')
    expect(store.shouldRefresh('fp-1')).toBe(false)
    at += AGENT_MODEL_CATALOG_FAILURE_TTL_MS
    expect(store.hasActiveFailure('fp-1')).toBe(false)
  })

  it('joins an in-flight refresh instead of starting a second fetch', async () => {
    const store = new AgentModelCatalogStore()
    let settle!: (value: AgentModelCatalogSuccess) => void
    const fetch = vi.fn(
      () => new Promise<AgentModelCatalogSuccess>((resolve) => (settle = resolve))
    )
    const session = liveLister(store)
    const first = store.refresh('fp-1', 'grok', session, fetch)
    const second = store.refresh('fp-1', 'grok', session, fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
    settle(success('gpt-a'))
    const [entryA, entryB] = await Promise.all([first, second])
    expect(entryA).toBe(entryB)
    expect(entryA!.models[0]!.id).toBe('gpt-a')
  })

  it('never makes a live session wait on another lister that hangs', async () => {
    const store = new AgentModelCatalogStore()
    let failProbe!: (error: Error) => void
    const hungProbe: AgentModelCatalogProbe = () =>
      new Promise<AgentModelCatalogSuccess>((_resolve, reject) => (failProbe = reject))
    const probe = store.refresh('fp-1', 'grok', hungProbe, () =>
      hungProbe({ variable: 'GROK_HOME', path: '/homes/a' })
    )
    expect(store.shouldRefresh('fp-1')).toBe(false)

    const live = await store.refresh('fp-1', 'grok', liveLister(store), async () =>
      success('gpt-live')
    )
    expect(live!.models[0]!.id).toBe('gpt-live')

    // The probe still reports its own failure; the live listing it lost to stays served.
    failProbe(new Error('codex app-server session exceeded 15000ms'))
    expect(await probe).toBeNull()
    expect(store.failureDetail('fp-1')).toBe('codex app-server session exceeded 15000ms')
    expect(store.get('fp-1')!.models[0]!.id).toBe('gpt-live')
  })

  it('answers a pending read with the first listing that succeeds, or null once all fail', async () => {
    const store = new AgentModelCatalogStore()
    expect(store.pendingListing('fp-1')).toBeNull()
    let failFirst!: (error: Error) => void
    let settleSecond!: (success: AgentModelCatalogSuccess) => void
    void store.refresh(
      'fp-1',
      'grok',
      liveLister(store),
      () => new Promise<AgentModelCatalogSuccess>((_resolve, reject) => (failFirst = reject))
    )
    void store.refresh(
      'fp-1',
      'grok',
      liveLister(store),
      () => new Promise<AgentModelCatalogSuccess>((resolve) => (settleSecond = resolve))
    )
    const pending = store.pendingListing('fp-1')
    failFirst(new Error('stuck'))
    settleSecond(success('gpt-second'))
    expect((await pending)!.models[0]!.id).toBe('gpt-second')

    void store.refresh('fp-2', 'grok', liveLister(store), async () => {
      throw new Error('no provider')
    })
    expect(await store.pendingListing('fp-2')).toBeNull()
  })

  it('ends a picker wait at its deadline even while a listing remains active', async () => {
    vi.useFakeTimers()
    try {
      const store = new AgentModelCatalogStore()
      let settle!: (success: AgentModelCatalogSuccess) => void
      const listing = store.refresh(
        'fp-1',
        'grok',
        liveLister(store),
        () => new Promise<AgentModelCatalogSuccess>((resolve) => (settle = resolve))
      )
      const waited = store.pendingListing('fp-1')
      await vi.advanceTimersByTimeAsync(AGENT_MODEL_CATALOG_PICKER_WAIT_MS)
      expect(await waited).toBeNull()
      settle(success('gpt-late'))
      expect((await listing)!.models[0]!.id).toBe('gpt-late')
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds back a probe until every lister settles, then lets the account refresh again', async () => {
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    let settleSlow!: (success: AgentModelCatalogSuccess) => void
    const slow = store.refresh(
      'fp-1',
      'grok',
      liveLister(store),
      () => new Promise<AgentModelCatalogSuccess>((resolve) => (settleSlow = resolve))
    )
    await store.refresh('fp-1', 'grok', liveLister(store), async () => success('gpt-fast'))
    at += AGENT_MODEL_CATALOG_FRESH_MS
    expect(store.shouldRefresh('fp-1')).toBe(false)

    settleSlow(success('gpt-slow'))
    await slow
    at += AGENT_MODEL_CATALOG_FRESH_MS
    // A leftover in-flight record here would suppress every later refresh for the account.
    expect(store.shouldRefresh('fp-1')).toBe(true)
  })

  it('keeps the newer completed listing when an older chat finishes later', async () => {
    const store = new AgentModelCatalogStore()
    const save = vi.fn()
    await store.attachPersistence({ load: async () => [], save, flush: async () => {} })
    let settleOlder!: (success: AgentModelCatalogSuccess) => void
    const older = store.refresh(
      'fp-1',
      'grok',
      liveLister(store),
      () => new Promise<AgentModelCatalogSuccess>((resolve) => (settleOlder = resolve))
    )
    const newer = await store.refresh('fp-1', 'grok', liveLister(store), async () =>
      success('gpt-new')
    )
    settleOlder(success('gpt-old'))
    const olderResult = await older

    expect(newer!.models[0]!.id).toBe('gpt-new')
    expect(olderResult!.models[0]!.id).toBe('gpt-old')
    expect(store.get('fp-1')!.models[0]!.id).toBe('gpt-new')
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('keeps a direct live update ahead of a pending older probe', async () => {
    const store = new AgentModelCatalogStore()
    let settleProbe!: (success: AgentModelCatalogSuccess) => void
    const probe: AgentModelCatalogProbe = () =>
      new Promise<AgentModelCatalogSuccess>((resolve) => (settleProbe = resolve))
    const pending = store.refresh('fp-1', 'grok', probe, () =>
      probe({ variable: 'GROK_HOME', path: '/homes/a' })
    )
    store.recordSuccess('fp-1', 'grok', success('gpt-live'), 'discovery')
    settleProbe({ ...success('gpt-probe'), origin: 'probe' })
    expect((await pending)!.models[0]!.id).toBe('gpt-probe')
    expect(store.get('fp-1')!.models[0]!.id).toBe('gpt-live')
  })

  it('still writes a pending probe that resolves after a live save, keeping both', async () => {
    const store = new AgentModelCatalogStore()
    let settleProbe!: (success: AgentModelCatalogSuccess) => void
    const probe: AgentModelCatalogProbe = () =>
      new Promise<AgentModelCatalogSuccess>((resolve) => (settleProbe = resolve))
    const pending = store.refresh('fp-1', 'grok', probe, () =>
      probe({ variable: 'GROK_HOME', path: '/homes/a' })
    )
    store.recordSuccess('fp-1', 'grok', success('gpt-live'), 'live')
    settleProbe({ ...success('gpt-probe'), origin: 'probe' })
    await pending
    const entry = store.get('fp-1')!
    expect(entry.discovered!.models[0]!.id).toBe('gpt-probe')
    expect(entry.live!.models[0]!.id).toBe('gpt-live')
    // A live save neither postpones the next discovery nor clears its failure back-off.
    store.recordFailure('fp-1', 'timed out')
    store.recordSuccess('fp-1', 'grok', success('gpt-live'), 'live')
    expect(store.hasActiveFailure('fp-1')).toBe(true)
  })

  it('keeps an older successful listing when the newer entry was evicted', async () => {
    const store = new AgentModelCatalogStore()
    let settleOlder!: (success: AgentModelCatalogSuccess) => void
    const older = store.refresh(
      'fp-1',
      'grok',
      liveLister(store),
      () => new Promise<AgentModelCatalogSuccess>((resolve) => (settleOlder = resolve))
    )
    await store.refresh('fp-1', 'grok', liveLister(store), async () => success('gpt-new'))
    for (let index = 0; index < AGENT_MODEL_CATALOG_MAX_ENTRIES; index++) {
      store.recordSuccess(`other-${index}`, 'grok', success('other'), 'discovery')
    }
    expect(store.get('fp-1')).toBeNull()
    const save = vi.fn()
    await store.attachPersistence({ load: async () => [], save, flush: async () => {} })

    settleOlder(success('gpt-old'))
    expect((await older)!.models[0]!.id).toBe('gpt-old')
    expect(store.get('fp-1')!.models[0]!.id).toBe('gpt-old')
    expect(Array.from(save.mock.calls[0]![0]())).toEqual(
      expect.arrayContaining([expect.objectContaining({ fingerprint: 'fp-1' })])
    )
  })

  it('records a failed refresh as a failure and resolves null without rejecting', async () => {
    const store = new AgentModelCatalogStore()
    const entry = await store.refresh('fp-1', 'grok', liveLister(store), async () => {
      throw new Error('no provider')
    })
    expect(entry).toBeNull()
    expect(store.get('fp-1')).toBeNull()
    expect(store.hasActiveFailure('fp-1')).toBe(true)
    expect(store.failureDetail('fp-1')).toBe('no provider')
  })

  it('keys entries by fingerprint so one account never answers for another', () => {
    const fingerprintA = agentModelCatalogFingerprint({
      agent: 'grok',
      accountHomeVariable: 'GROK_HOME',
      accountHomePath: '/homes/a',
      wslDistro: null
    })
    const fingerprintB = agentModelCatalogFingerprint({
      agent: 'grok',
      accountHomeVariable: 'GROK_HOME',
      accountHomePath: '/homes/b',
      wslDistro: null
    })
    expect(fingerprintA).not.toBe(fingerprintB)
    const store = new AgentModelCatalogStore()
    store.recordSuccess(fingerprintA, 'grok', success('gpt-a'), 'discovery')
    expect(store.get(fingerprintB)).toBeNull()
  })

  it('derives the record fingerprint from the pinned account home', () => {
    const record: Pick<AgentSessionRecord, 'provider' | 'accountHome' | 'location'> = {
      provider: 'grok',
      accountHome: { variable: 'GROK_HOME', path: '/homes/a' },
      location: {
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        wslDistro: null,
        workspaceId: 'ws-1',
        workspaceKind: 'git-worktree'
      }
    }
    expect(agentModelCatalogFingerprintForRecord(record)).toBe(
      agentModelCatalogFingerprint({
        agent: 'grok',
        accountHomeVariable: 'GROK_HOME',
        accountHomePath: '/homes/a',
        wslDistro: null
      })
    )
  })

  it.each([10, 100])('ignores %i unchanged listings while still refreshing their age', (count) => {
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    const save = vi.fn()
    void store.attachPersistence({ load: async () => [], save, flush: async () => {} })
    store.recordSuccess('fp', 'grok', success('opus'), 'discovery')
    at += AGENT_MODEL_CATALOG_FRESH_MS
    for (let index = 0; index < count; index++) {
      store.recordSuccess('fp', 'grok', success('opus'), 'discovery')
    }
    expect(save).toHaveBeenCalledTimes(1)
    expect(store.shouldRefresh('fp')).toBe(false)
    store.recordSuccess('fp', 'grok', success('opus', 'sonnet'), 'discovery')
    expect(save).toHaveBeenCalledTimes(2)
  })

  it("keeps a live child's default effort through a listing that names none, across a restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-'))
    const store = new AgentModelCatalogStore()
    await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    const efforts = [
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' }
    ]
    const listing = (defaultEffort?: string): AgentModelCatalogSuccess => ({
      models: [
        {
          id: 'opus',
          label: 'Opus',
          isDefault: true,
          efforts,
          ...(defaultEffort ? { defaultEffort } : {})
        }
      ],
      origin: 'live-session'
    })
    store.recordSuccess('fp', 'grok', listing('medium'), 'live')
    // A session-less probe never names the provider's default.
    store.recordSuccess('fp', 'grok', { ...listing(), origin: 'probe' }, 'discovery')
    expect(store.get('fp')!.models[0]!.defaultEffort).toBe('medium')
    await store.flushPersistence()
    const restarted = new AgentModelCatalogStore()
    await restarted.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    expect(restarted.get('fp')!.models[0]!.defaultEffort).toBe('medium')

    // A newer report replaces it; a model that stops offering it drops it.
    store.recordSuccess('fp', 'grok', listing('high'), 'live')
    expect(store.get('fp')!.models[0]!.defaultEffort).toBe('high')
    store.recordSuccess(
      'fp',
      'grok',
      {
        ...listing(),
        models: [{ id: 'opus', label: 'Opus', isDefault: true, efforts: [efforts[0]!] }]
      },
      'live'
    )
    expect(store.get('fp')!.models[0]).not.toHaveProperty('defaultEffort')
  })

  it('keeps a CLI-resolved configured default through later listings and a restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-'))
    const store = new AgentModelCatalogStore()
    await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    // Never on its own: there is no catalog to name a default in yet.
    store.recordConfiguredDefault('fp', { modelId: 'sonnet' })
    expect(store.get('fp')).toBeNull()

    store.recordSuccess('fp', 'grok', success('opus', 'sonnet'), 'live')
    store.recordConfiguredDefault('fp', { modelId: 'sonnet', effort: 'high' })
    store.recordSuccess(
      'fp',
      'grok',
      { ...success('opus', 'sonnet'), origin: 'probe' },
      'discovery'
    )
    const named = (entry: ReturnType<typeof store.get>) =>
      entry?.models.filter((model) => model.isDefault).map((model) => model.id)
    expect(named(store.get('fp'))).toEqual(['sonnet'])

    await store.flushPersistence()
    const restarted = new AgentModelCatalogStore()
    await restarted.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    expect(restarted.get('fp')?.configured).toMatchObject({
      modelId: 'sonnet',
      effort: 'high'
    })
    expect(named(restarted.get('fp'))).toEqual(['sonnet'])
    const sonnet = restarted.get('fp')?.models.find((model) => model.id === 'sonnet')
    expect(sonnet?.defaultEffort).toBe('high')

    restarted.recordConfiguredDefault('fp', null)
    expect(restarted.get('fp')?.configured).toBeNull()
    expect(restarted.get('fp')?.models.find((model) => model.id === 'sonnet')).not.toHaveProperty(
      'defaultEffort'
    )
  })

  it('persists successes only and hydrates them across a restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-'))
    const store = new AgentModelCatalogStore()
    await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    store.recordSuccess('fp-1', 'grok', success('gpt-a'), 'discovery')
    store.recordFailure('fp-2', 'timed out')
    await vi.waitFor(
      async () => {
        const persisted = await createAgentModelCatalogFilePersistence(directory).load()
        expect(persisted.map((entry) => entry.fingerprint)).toEqual(['fp-1'])
      },
      { timeout: 3_000 }
    )
    const restarted = new AgentModelCatalogStore()
    await restarted.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    const entry = restarted.get('fp-1')!
    expect(entry.models.map((model) => model.id)).toEqual(['gpt-a'])
    // The failure died with the process: doubt is never a durable fact.
    expect(restarted.hasActiveFailure('fp-2')).toBe(false)
    expect(restarted.get('fp-2')).toBeNull()
  })

  it('keeps a model’s service tiers across a restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-'))
    const store = new AgentModelCatalogStore()
    await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    const serviceTiers = [
      { value: 'priority', label: 'Fast', description: '2x speed' },
      { value: 'ultrafast', label: 'Ultrafast' }
    ]
    store.recordSuccess(
      'fp-tiers',
      'grok',
      {
        models: [{ id: 'gpt-a', label: 'A', isDefault: true, efforts: [], serviceTiers }],
        origin: 'probe'
      },
      'discovery'
    )
    await store.flushPersistence()
    const [saved] = await createAgentModelCatalogFilePersistence(directory).load()
    expect(saved?.models[0]?.serviceTiers).toEqual(serviceTiers)
  })

  it('imports complete schema3 sources only after hydration, with current entries and retention winning', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-import-'))
    const seed = new AgentModelCatalogStore()
    for (let i = 0; i < 253; i++) {
      seed.recordSuccess(`fp-${i}`, 'grok', success('disk'), 'discovery')
    }
    seed.recordSuccess('fp-251', 'grok', success('live', 'chosen'), 'live')
    seed.recordConfiguredDefault('fp-251', { modelId: 'chosen', effort: 'high' })
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
      discovered: { models: [{ id: 'disk' }] },
      live: { models: [{ id: 'live' }, { id: 'chosen' }] },
      configured: { modelId: 'chosen', effort: 'high' }
    })
    expect(readFileSync(legacy, 'utf8')).toBe(bytes)
    store.get('fp-252')
    store.recordSuccess('extra', 'grok', success('extra'), 'live')
    await store.flushPersistence()
    expect(await persistence.load()).toHaveLength(256)
    expect(store.get('new')).toBeNull()
    const restored = new AgentModelCatalogStore()
    await restored.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    expect(restored.get('fp-251')?.configured?.modelId).toBe('chosen')
    rmSync(directory, { recursive: true, force: true })
  })

  it.each([10, 100])('keyed %i bursts retain latest source/order', async (count) => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-keyed-'))
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    const persistence = createAgentModelCatalogFilePersistence(directory)
    await store.attachPersistence(persistence)
    const run = vi.spyOn(NodeSqliteStatement.prototype, 'run')
    const scans = vi.fn<Parameters<typeof persistence.save>[0]>()
    const save = persistence.save
    vi.spyOn(persistence, 'save').mockImplementation((source) => {
      scans.mockImplementation(source)
      save(scans)
    })
    for (let i = 0; i < count; i++) {
      store.recordSuccess(`fp-${i}`, 'grok', success('model', 'chosen'), 'live')
    }
    expect(run).not.toHaveBeenCalled()
    expect(scans).not.toHaveBeenCalled()
    const first = store.flushPersistence()
    expect(store.flushPersistence()).toBe(first)
    await first
    expect(run.mock.calls.filter((args) => args.length === 4)).toHaveLength(count)
    expect(scans).toHaveBeenCalledTimes(2)
    at++
    store.get('fp-0')
    store.recordSuccess('fp-1', 'grok', success('model', 'chosen'), 'live')
    store.recordConfiguredDefault('fp-0', { modelId: 'chosen' })
    let changed = false
    run.mockRestore()
    const nativeRun = NodeSqliteStatement.prototype.run
    const sparse = vi.spyOn(NodeSqliteStatement.prototype, 'run')
    sparse.mockImplementation(function (this: NodeSqliteStatement, ...args) {
      const result = nativeRun.apply(this, args)
      if (!changed && args.length === 4) {
        changed = true
        queueMicrotask(() => {
          at++
          store.recordSuccess('fp-1', 'grok', success('model', 'chosen'), 'live')
          store.get('fp-0')
        })
      }
      return result
    })
    await store.flushPersistence()
    expect(sparse.mock.calls.filter((args) => args.length === 4)).toHaveLength(3)
    sparse.mockRestore()
    const loaded = await persistence.load()
    expect(loaded.at(-1)?.fingerprint).toBe('fp-0')
    expect(loaded.find((row) => row.fingerprint === 'fp-1')?.live?.at).toBe(at)
    expect(loaded.at(-1)?.configured?.modelId).toBe('chosen')
    rmSync(directory, { recursive: true, force: true })
  })
  it('paces normal starts at 500ms and keeps changes during an active write owed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-cadence-'))
    const store = new AgentModelCatalogStore()
    const persistence = createAgentModelCatalogFilePersistence(directory)
    await store.attachPersistence(persistence)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const started = Date.now()
    const starts: number[] = []
    const exec = sql.exec
    const { promise: committed, resolve: firstCommitted } = Promise.withResolvers<void>()
    const writing = vi.spyOn(sql, 'exec').mockImplementation(function (this: SyncDatabase, sql) {
      if (sql.includes('BEGIN IMMEDIATE')) {
        starts.push(Date.now())
      }
      const result = exec.call(this, sql)
      if (sql === 'COMMIT' && starts.length === 1) {
        store.recordSuccess('newer', 'grok', success('newer'), 'live')
        firstCommitted()
      }
      return result
    })
    try {
      store.recordSuccess('first', 'grok', success('first'), 'live')
      await vi.advanceTimersByTimeAsync(499)
      expect(starts).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await committed
      // Join retirement without explicit flush bypassing the next normal deadline.
      await persistence.load()
      await vi.advanceTimersByTimeAsync(499)
      expect(starts).toEqual([started + 500])
      await vi.advanceTimersByTimeAsync(1)
      await store.flushPersistence()
      expect(starts).toEqual([started + 500, started + 1_000])
      expect((await persistence.load()).map((row) => row.fingerprint)).toEqual(['first', 'newer'])
    } finally {
      writing.mockRestore()
      vi.useRealTimers()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it.each(transactions)('atomic %i/%s sparse retry', async (count, stage) => {
    vi.restoreAllMocks()
    const directory = mkdtempSync(join(tmpdir(), 'catalog-transaction-'))
    const legacy = join(directory, 'agent-model-catalog.json')
    const seed = new AgentModelCatalogStore()
    const retained = Array.from({ length: count - 1 }, (_, i) =>
      seed.recordSuccess(`kept-${i}`, 'grok', success('kept'), 'discovery')!
    )
    const old = seed.recordSuccess('old', 'grok', success('old'), 'discovery')!
    writeFileSync(legacy, JSON.stringify({ version: 3, entries: [...retained, seed.get('old')] }))
    if (stage === 'first') {
      const child = spawnSync(process.execPath, [
        '-e',
        `const d=new(require('node:sqlite').DatabaseSync)(process.argv[1]);d.exec('BEGIN IMMEDIATE;CREATE TABLE unfinished(x);INSERT INTO unfinished VALUES(1)');process.exit(0)`,
        join(directory, 'agent-model-catalog.db')
      ])
      expect(child.status).toBe(0)
    }
    let source = new Map([...retained, seed.get('old')!].map((e) => [e.fingerprint, e]))
    const persistence = createAgentModelCatalogFilePersistence(directory)
    await persistence.attach!(() => source.values(), vi.fn())
    if (!stage.endsWith('first')) {
      await persistence.flush()
    }
    const before = await persistence.load()
    seed.recordConfiguredDefault('old', { modelId: 'old', effort: 'high' })
    source.set('old', seed.get('old')!)
    if (stage.includes('delete')) {
      source.delete('old')
      source.set('new', seed.recordSuccess('new', 'grok', success('new'), 'live')!)
    }
    source.delete(retained[0]!.fingerprint)
    source.set(retained[0]!.fingerprint, retained[0]!)
    const attempted = [...source.values()]
    persistence.save(() => source.values())
    const exec = sql.exec
    const run = NodeSqliteStatement.prototype.run
    let failed = false
    let retirementFailed = false
    const closing = vi.spyOn(sql, 'close')
    if (stage === 'close') {
      closing.mockImplementationOnce(() => {
        throw new Error('close')
      })
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fault = vi.spyOn(sql, 'exec').mockImplementation(function (this: SyncDatabase, sql) {
      if (stage === 'rollback' && sql === 'ROLLBACK' && !retirementFailed) {
        retirementFailed = true
        throw new Error('rollback')
      }
      if (
        !failed &&
        (sql === 'COMMIT' || (stage === 'busy' && sql.includes('BEGIN IMMEDIATE'))) &&
        !['row', 'delete', 'rollback', 'close'].includes(stage)
      ) {
        failed = true
        if (stage.startsWith('uncertain')) {
          exec.call(this, sql)
        }
        throw new Error(stage)
      }
      return exec.call(this, sql)
    })
    const rowFault = vi.spyOn(NodeSqliteStatement.prototype, 'run')
    rowFault.mockImplementation(function (this: NodeSqliteStatement, ...args) {
      if (args.length === 4 && args[0] === (stage === 'uncertain-delete-revert' ? 'new' : 'old')) {
        queueMicrotask(() => {
          source = new Map(retained.map((e) => [e.fingerprint, e]))
          source.set('old', stage.endsWith('revert') ? old : seed.get('old')!)
        })
      }
      if (
        !failed &&
        ((['row', 'rollback', 'close'].includes(stage) && args.length === 4) ||
          (stage === 'delete' && args.length === 1))
      ) {
        failed = true
        throw new Error(stage)
      }
      return run.apply(this, args)
    })
    await persistence.flush()
    expect([failed, warn.mock.calls.length]).toEqual([true, 1])
    expect(await persistence.load()).toEqual(stage.startsWith('uncertain') ? attempted : before)
    if (stage === 'close') {
      expect(closing.mock.contexts[0]).toBe(closing.mock.contexts[1])
    }
    if (stage === 'rollback') {
      const contexts = fault.mock.contexts.filter((_, i) => fault.mock.calls[i]![0] === 'ROLLBACK')
      expect(contexts).toHaveLength(2)
      expect(contexts[0]).toBe(contexts[1])
    }
    const attempts = fault.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(fault).toHaveBeenCalledTimes(attempts)
    rowFault.mockClear()
    await persistence.flush()
    expect(rowFault.mock.calls.filter((args) => args.length === 4)).toHaveLength(
      stage.endsWith('first') ? count : 1
    )
    expect(await persistence.load()).toEqual([...source.values()])
    vi.restoreAllMocks()
    source.clear()
    persistence.save(() => source.values())
    await persistence.flush()
    expect(await createAgentModelCatalogFilePersistence(directory).load()).toEqual([])
    expect(readFileSync(legacy, 'utf8')).toContain('old')
    rmSync(directory, { recursive: true, force: true })
  })
  it.each([
    'PRAGMA user_version=99',
    'CREATE TABLE foreign_data(x)',
    "UPDATE catalog SET payload='{}'"
  ])('retries transient initialization and preserves invalid authority: %s', async (corrupt) => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-authority-'))
    const legacy = join(directory, 'agent-model-catalog.json')
    const seed = new AgentModelCatalogStore()
    seed.recordSuccess('disk', 'grok', success('disk'), 'discovery')
    const bytes = JSON.stringify({ version: 3, entries: [seed.get('disk')] })
    writeFileSync(legacy, bytes)
    renameSync(legacy, `${legacy}.backup`)
    mkdirSync(legacy)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = new AgentModelCatalogStore()
    const persistence = createAgentModelCatalogFilePersistence(directory)
    await store.attachPersistence(persistence)
    expect(store.get('disk')).toBeNull()
    expect(existsSync(join(directory, 'agent-model-catalog.db'))).toBe(false)
    rmSync(legacy, { recursive: true })
    renameSync(`${legacy}.backup`, legacy)
    await store.flushPersistence()
    expect(store.get('disk')?.models[0]?.id).toBe('disk')
    const db = new SyncDatabase(join(directory, 'agent-model-catalog.db'))
    db.exec(corrupt)
    db.close()
    const prior = readFileSync(join(directory, 'agent-model-catalog.db'))
    const later = new AgentModelCatalogStore()
    await later.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    expect(later.get('disk')).toBeNull()
    later.recordSuccess('memory', 'grok', success('memory'), 'live')
    await later.flushPersistence()
    expect(later.get('memory')).not.toBeNull()
    expect(readFileSync(join(directory, 'agent-model-catalog.db'))).toEqual(prior)
    expect(readFileSync(legacy, 'utf8')).toBe(bytes)
    warn.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  })
  it.each([
    '{"version":3,"entries":[]} trailing',
    '{"version":3,"entries":[]',
    '{"version":4,"entries":[]}',
    '{"version":3,"entries":[],"entries":{}}'
  ])('preserves an invalid final legacy document: %s', async (bytes) => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-framing-'))
    const legacy = join(directory, 'agent-model-catalog.json')
    writeFileSync(legacy, bytes)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = new AgentModelCatalogStore()
    await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    store.recordSuccess('memory', 'grok', success('memory'), 'live')
    await store.flushPersistence()
    expect(store.get('memory')).not.toBeNull()
    expect(readFileSync(legacy, 'utf8')).toBe(bytes)
    expect(existsSync(join(directory, 'agent-model-catalog.db'))).toBe(false)
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
