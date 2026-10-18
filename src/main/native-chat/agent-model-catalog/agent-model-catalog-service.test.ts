import { homedir } from 'node:os'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogFingerprintForRecord,
  agentModelCatalogScopeFingerprint
} from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  AGENT_MODEL_CATALOG_FRESH_MS,
  AgentModelCatalogStore,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'

function record(accountHomePath: string): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only provider, accountHome and location; the rest of the record is irrelevant here.
  return {
    sessionId: 'session-1',
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: accountHomePath },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'ws-1',
      workspaceKind: 'git-worktree'
    }
  } as AgentSessionRecord
}

function listing(id: string): AgentModelCatalogSuccess {
  return {
    models: [{ id, label: id, isDefault: true, efforts: [] }],
    origin: 'probe',
    complete: true
  }
}

function selectedHomeFingerprint(path: string, cwd: string | null = homedir()): string {
  const account = agentModelCatalogFingerprint({
    agent: 'codex',
    accountHomeVariable: 'CODEX_HOME',
    accountHomePath: path,
    wslDistro: null
  })
  return cwd ? agentModelCatalogScopeFingerprint(account, cwd) : account
}

const CODEX_HOME = (path: string): { variable: 'CODEX_HOME'; path: string } => ({
  variable: 'CODEX_HOME',
  path
})

describe('agent model catalog service', () => {
  it('delivers cold legacy discovery without delaying its first reply or joining the modern queue', async () => {
    vi.useFakeTimers()
    const releases: (() => void)[] = []
    const legacyRun = vi.fn(async () => {
      await new Promise((done) => setTimeout(done, 1_000))
      return listing('account')
    })
    const resolveLegacy = vi.fn(async () => {
      await new Promise((done) => setTimeout(done, 18_000))
      return { identity: 'account-launch', run: legacyRun }
    })
    const probe = Object.assign(async () => listing('unused'), {
      resolve: async (_home: AgentSessionAccountHome, cwd: string) => ({
        identity: cwd,
        run: async () => {
          await new Promise<void>((done) => releases.push(done))
          return listing(cwd)
        }
      }),
      resolveLegacy
    })
    const service = createAgentModelCatalogService({
      store: new AgentModelCatalogStore(),
      getRecord: () => record('/pinned'),
      drivesRecord: () => true,
      resolveAccountHome: async () => CODEX_HOME('/selected'),
      recordWorkspacePath: async () => '/exact',
      probes: { codex: probe }
    })
    try {
      for (let i = 0; i < 6; i++) {
        await service.read({ agent: 'codex', sessionId: `s${i}`, workspacePath: `/folder-${i}` })
      }
      expect(releases).toHaveLength(2)
      const requests = Array.from({ length: 7 }, (_, i) => ({
        agent: 'codex',
        sessionId: 's0',
        workspacePath: i ? `/legacy-${i}` : null,
        legacy: true
      }))
      for (const request of requests) {
        expect(await service.read(request)).toEqual({ origin: 'unknown', listingInProgress: true })
      }
      const waited = Promise.all(
        requests.map((request) => service.read({ ...request, waitForListing: true }))
      )
      expect(resolveLegacy).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(19_000)
      const answers = await waited
      expect(
        answers.every((answer) => answer.origin !== 'unknown' && answer.models[0]?.id === 'account')
      ).toBe(true)
      expect(answers[0]).toMatchObject({ models: [{ isDefault: false }] })
      expect(legacyRun).toHaveBeenCalledTimes(1)
      expect(service.peek('s0')).toBeNull()
    } finally {
      service.stop()
      for (const release of releases) {
        release()
      }
      vi.useRealTimers()
    }
  })

  it('answers unknown and kicks one probe for a session whose key has never listed', async () => {
    const store = new AgentModelCatalogStore()
    const probe = vi.fn(async (_home: AgentSessionAccountHome) => listing('gpt-a'))
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => record('/homes/a'),
      drivesRecord: () => true,
      recordWorkspacePath: async () => '/repo/wt',
      resolveAccountHome: async () => CODEX_HOME('/homes/selected'),
      probes: { codex: probe }
    })
    expect(await service.read({ agent: 'codex', sessionId: 'session-1' })).toMatchObject({
      origin: 'unknown',
      listingInProgress: true
    })
    // A second read while the probe is in flight must not start another, and a
    // record-scoped read probes the RECORD's pinned home, not the selection.
    await service.read({ agent: 'codex', sessionId: 'session-1' })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith(CODEX_HOME('/homes/a'), {
      cwd: expect.any(String),
      signal: expect.any(AbortSignal)
    })
    await vi.waitFor(async () => {
      const result = await service.read({ agent: 'codex', sessionId: 'session-1' })
      expect(result.origin).toBe('probe')
    })
  })

  it('never probes a different account for an unsupported pinned record', async () => {
    const probe = vi.fn(async () => listing('gpt-a'))
    const service = createAgentModelCatalogService({
      store: new AgentModelCatalogStore(),
      getRecord: () => record('/homes/a'),
      drivesRecord: () => false,
      resolveAccountHome: async () => CODEX_HOME('/homes/selected'),
      probes: { codex: probe }
    })
    expect(await service.read({ agent: 'codex', sessionId: 'session-1' })).toMatchObject({
      origin: 'unknown'
    })
    expect(probe).not.toHaveBeenCalled()
  })

  it('an account switch with no record reads and prewarms the NEW account, never the old entry', async () => {
    const store = new AgentModelCatalogStore()
    // The old account listed under its own fingerprint before the switch.
    const oldFingerprint = selectedHomeFingerprint('/homes/old')
    store.recordSuccess(oldFingerprint, 'codex', listing('gpt-old'), 'discovery')
    const probe = vi.fn(async () => listing('gpt-new'))
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: async () => CODEX_HOME('/homes/new'),
      probes: { codex: probe }
    })
    // The record-less read follows the CURRENT selection: unknown, never gpt-old.
    expect(await service.read({ agent: 'codex' })).toMatchObject({
      origin: 'unknown',
      listingInProgress: true
    })
    expect(probe).toHaveBeenCalledWith(CODEX_HOME('/homes/new'), {
      cwd: expect.any(String),
      signal: expect.any(AbortSignal)
    })
    await vi.waitFor(async () => {
      const result = await service.read({ agent: 'codex' })
      expect(result.origin === 'unknown' ? null : result.models[0]!.id).toBe('gpt-new')
    })
    // The new listing landed under the new selection's key; the old entry is untouched.
    expect(store.get(selectedHomeFingerprint('/homes/new'))!.models[0]!.id).toBe('gpt-new')
    expect(store.get(oldFingerprint)!.models[0]!.id).toBe('gpt-old')
  })

  it('a record-less read serves the selected account entry when it exists', async () => {
    const store = new AgentModelCatalogStore()
    store.recordSuccess(
      selectedHomeFingerprint('/homes/selected'),
      'codex',
      listing('gpt-mine'),
      'discovery'
    )
    store.recordSuccess(
      selectedHomeFingerprint('/homes/other'),
      'codex',
      listing('gpt-other'),
      'discovery'
    )
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: async () => CODEX_HOME('/homes/selected')
    })
    const result = await service.read({ agent: 'codex' })
    expect(result.origin === 'unknown' ? null : result.models[0]!.id).toBe('gpt-mine')
  })

  it('a session record outranks the current selection for its own reads', async () => {
    const store = new AgentModelCatalogStore()
    const sessionRecord = record('/homes/session')
    store.recordSuccess(
      agentModelCatalogScopeFingerprint(
        agentModelCatalogFingerprintForRecord(sessionRecord),
        '/repo/wt'
      ),
      'codex',
      listing('gpt-session'),
      'discovery'
    )
    store.recordSuccess(
      selectedHomeFingerprint('/homes/selected'),
      'codex',
      listing('gpt-selected'),
      'discovery'
    )
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => sessionRecord,
      drivesRecord: () => true,
      recordWorkspacePath: async () => '/repo/wt',
      resolveAccountHome: async () => CODEX_HOME('/homes/selected')
    })
    const result = await service.read({ agent: 'codex', sessionId: 'session-1' })
    expect(result.origin === 'unknown' ? null : result.models[0]!.id).toBe('gpt-session')
  })

  it('a probe failure is a TTL-bounded fact, never an answer', async () => {
    const store = new AgentModelCatalogStore()
    const probe = vi.fn(async () => {
      throw new Error('spawn failed')
    })
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => record('/homes/a'),
      drivesRecord: () => true,
      recordWorkspacePath: async () => '/repo/wt',
      resolveAccountHome: async () => CODEX_HOME('/homes/a'),
      probes: { codex: probe }
    })
    expect(await service.read({ agent: 'codex', sessionId: 'session-1' })).toMatchObject({
      origin: 'unknown',
      listingInProgress: true
    })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    // Still a clean unknown — and the failure TTL suppresses a probe storm.
    expect(await service.read({ agent: 'codex', sessionId: 'session-1' })).toMatchObject({
      origin: 'unknown'
    })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('a failed account-home resolution answers unknown without probing', async () => {
    const store = new AgentModelCatalogStore()
    const probe = vi.fn(async () => listing('gpt-a'))
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: async () => {
        throw new Error('no store yet')
      },
      probes: { codex: probe }
    })
    expect(await service.read({ agent: 'codex' })).toMatchObject({ origin: 'unknown' })
    expect(probe).not.toHaveBeenCalled()
  })

  describe('a read that waits for the first listing', () => {
    function deferredListing() {
      let resolve!: (success: AgentModelCatalogSuccess) => void
      let reject!: (error: Error) => void
      const promise = new Promise<AgentModelCatalogSuccess>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }

    function coldService(
      probe: (home: AgentSessionAccountHome) => Promise<AgentModelCatalogSuccess>
    ) {
      const store = new AgentModelCatalogStore()
      const service = createAgentModelCatalogService({
        store,
        getRecord: () => undefined,
        drivesRecord: () => true,
        resolveAccountHome: async () => CODEX_HOME('/homes/selected'),
        probes: { codex: probe }
      })
      return { store, service }
    }

    it('joins the listing the first read started and answers with it', async () => {
      const pending = deferredListing()
      const probe = vi.fn(() => pending.promise)
      const { service } = coldService(probe)
      expect(await service.read({ agent: 'codex' })).toMatchObject({
        origin: 'unknown',
        listingInProgress: true
      })
      const waited = service.read({ agent: 'codex', waitForListing: true })
      pending.resolve(listing('gpt-listed'))
      const result = await waited
      expect(result.origin === 'unknown' ? null : result.models[0]!.id).toBe('gpt-listed')
      expect(probe).toHaveBeenCalledTimes(1)
    })

    it('answers a plain unknown when the listing fails', async () => {
      const pending = deferredListing()
      const { service } = coldService(() => pending.promise)
      const waited = service.read({ agent: 'codex', waitForListing: true })
      pending.reject(new Error('spawn failed'))
      expect(await waited).toMatchObject({ origin: 'unknown' })
    })

    it('does not wait or report a listing while a failure is inside its TTL', async () => {
      const probe = vi.fn(async (): Promise<AgentModelCatalogSuccess> => {
        throw new Error('spawn failed')
      })
      const { store, service } = coldService(probe)
      store.recordFailure(selectedHomeFingerprint('/homes/selected'), 'spawn failed')
      expect(await service.read({ agent: 'codex', waitForListing: true })).toMatchObject({
        origin: 'unknown'
      })
      expect(await service.read({ agent: 'codex' })).toMatchObject({ origin: 'unknown' })
      expect(probe).not.toHaveBeenCalled()
    })

    it('reports no listing where the host has no lister for the account', async () => {
      const store = new AgentModelCatalogStore()
      const service = createAgentModelCatalogService({
        store,
        getRecord: () => undefined,
        drivesRecord: () => true,
        resolveAccountHome: async () => CODEX_HOME('/homes/selected')
      })
      expect(await service.read({ agent: 'codex', waitForListing: true })).toMatchObject({
        origin: 'unknown'
      })
    })

    it('serves an aged entry at once and refreshes it behind the answer', async () => {
      const pinned = { ...record('/homes/selected'), provider: 'claude' }
      let now = 0
      const store = new AgentModelCatalogStore({ now: () => now })
      store.recordSuccess(
        agentModelCatalogScopeFingerprint(
          agentModelCatalogFingerprintForRecord(pinned),
          '/repo/wt'
        ),
        'claude',
        listing('gpt-old'),
        'discovery'
      )
      now = AGENT_MODEL_CATALOG_FRESH_MS
      const refreshed = deferredListing()
      const probe = vi.fn(() => refreshed.promise)
      const service = createAgentModelCatalogService({
        store,
        getRecord: () => pinned,
        drivesRecord: () => true,
        recordWorkspacePath: async () => '/repo/wt',
        resolveAccountHome: async () => CODEX_HOME('/homes/selected'),
        probes: { claude: probe }
      })
      const result = await service.read({ agent: 'claude', sessionId: pinned.sessionId })
      expect(result.origin === 'unknown' ? null : result.models[0]!.id).toBe('gpt-old')
      expect(result.listingInProgress).toBe(true)
      const waiting = service.read({
        agent: 'claude',
        sessionId: pinned.sessionId,
        waitForListing: true
      })
      refreshed.resolve(listing('gpt-new'))
      expect(await waiting).toMatchObject({ models: [{ id: 'gpt-new' }] })
      expect(probe).toHaveBeenCalledTimes(1)
    })
  })

  describe('a read for the workspace a new chat runs in', () => {
    function serviceWith(mayOverride: boolean) {
      const store = new AgentModelCatalogStore()
      store.recordSuccess(
        selectedHomeFingerprint('/homes/selected', '/repo/wt'),
        'codex',
        listing('gpt-user'),
        'discovery'
      )
      const workspaceMayOverrideDefaultModel = vi.fn(async () => mayOverride)
      const service = createAgentModelCatalogService({
        store,
        getRecord: () => undefined,
        drivesRecord: () => true,
        resolveAccountHome: async () => CODEX_HOME('/homes/selected'),
        workspaceMayOverrideDefaultModel
      })
      return { service, workspaceMayOverrideDefaultModel }
    }

    function defaults(
      result: Awaited<ReturnType<ReturnType<typeof serviceWith>['service']['read']>>
    ) {
      return result.origin === 'unknown' ? null : result.models.map((model) => model.isDefault)
    }

    it('names no default when the workspace config could pick another model', async () => {
      const { service, workspaceMayOverrideDefaultModel } = serviceWith(true)
      const result = await service.read({ agent: 'codex', workspacePath: '/repo/wt' })
      expect(defaults(result)).toEqual([false])
      expect(workspaceMayOverrideDefaultModel).toHaveBeenCalledWith({
        agent: 'codex',
        workspacePath: '/repo/wt',
        accountHomePath: '/homes/selected'
      })
    })

    it('keeps the listed default when nothing in the workspace can replace it', async () => {
      const { service } = serviceWith(false)
      expect(defaults(await service.read({ agent: 'codex', workspacePath: '/repo/wt' }))).toEqual([
        true
      ])
    })

    it('names no default for a workspace it could not place on this machine', async () => {
      const { service, workspaceMayOverrideDefaultModel } = serviceWith(false)
      expect(defaults(await service.read({ agent: 'codex', workspacePath: null }))).toBeNull()
      expect(workspaceMayOverrideDefaultModel).not.toHaveBeenCalled()
    })

    it('leaves a read that names no workspace as it was', async () => {
      const { service, workspaceMayOverrideDefaultModel } = serviceWith(true)
      expect(defaults(await service.read({ agent: 'codex' }))).toBeNull()
      expect(workspaceMayOverrideDefaultModel).not.toHaveBeenCalled()
    })
  })

  describe('an agent whose account is not one directory', () => {
    const managed = (id: string): AgentSessionAccountHome => ({
      kind: 'opencode',
      locator: { kind: 'managed', managedProfileId: id }
    })
    const PROFILE_A = '0b0c6f5e-4f51-4c4a-9d3e-1a2b3c4d5e6f'
    const PROFILE_B = '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f'
    const openCodeRecord = (
      home: AgentSessionAccountHome,
      wslDistro: string | null = null
    ): AgentSessionRecord => ({
      ...record('/unused'),
      provider: 'opencode',
      accountHome: home,
      location: { ...record('/unused').location, wslDistro }
    })

    it('probes under the account the chat pinned, and keeps each account’s listing apart', async () => {
      const store = new AgentModelCatalogStore()
      const probe = vi.fn(async (home: AgentSessionAccountHome) => listing(JSON.stringify(home)))
      const service = createAgentModelCatalogService({
        store,
        getRecord: () => openCodeRecord(managed(PROFILE_A)),
        drivesRecord: () => true,
        recordWorkspacePath: async () => '/repo/wt',
        resolveAccountHome: async () => managed(PROFILE_B),
        probes: { opencode: probe }
      })
      await service.read({ agent: 'opencode', sessionId: 'session-1', waitForListing: true })
      await service.read({ agent: 'opencode', waitForListing: true })
      expect(probe.mock.calls.map(([home]) => home)).toEqual([
        managed(PROFILE_A),
        managed(PROFILE_B)
      ])
      const pinned = await service.read({ agent: 'opencode', sessionId: 'session-1' })
      const selected = await service.read({ agent: 'opencode' })
      expect(pinned.origin !== 'unknown' && pinned.models[0]!.id).toContain(PROFILE_A)
      expect(selected.origin !== 'unknown' && selected.models[0]!.id).toContain(PROFILE_B)
    })

    it('starts no host-side probe for a chat pinned inside WSL', async () => {
      const probe = vi.fn(async () => listing('never'))
      const service = createAgentModelCatalogService({
        store: new AgentModelCatalogStore(),
        getRecord: () => openCodeRecord(managed(PROFILE_A), 'Ubuntu'),
        drivesRecord: () => true,
        recordWorkspacePath: async () => '/repo/wt',
        resolveAccountHome: async () => managed(PROFILE_B),
        probes: { opencode: probe }
      })
      expect(await service.read({ agent: 'opencode', sessionId: 'session-1' })).toMatchObject({
        origin: 'unknown'
      })
      expect(probe).not.toHaveBeenCalled()
    })
  })
})
