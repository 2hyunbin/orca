import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../../runtime/agent-session-record-store-test-harness'
import { agentSessionRuntimeIncarnation } from '../../runtime/agent-session-runtime-attribution'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { JournalLegacyRestInitializer } from '../agent-session-journal/journal-legacy-rest-initializer'
import { readJournalRestFacts } from '../agent-session-journal/journal-row-table'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import {
  beginStructuredJournalForeground,
  setStructuredAgentSessionHost,
  setStructuredJournalReadiness
} from './structured-agent-session-registry'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'

let root: string
let host: StructuredAgentSessionHost | undefined
const NOW = 1_800_000_000_000
const savedAt = 100
const sessionId = 'r3-cold-session'
const record = (id = sessionId) => {
  const value = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      sessionId: id,
      runtimeFence: 7,
      unreconciled: true,
      ownerProcess: {
        hostId: 'local',
        pid: 4242,
        processStartTimeMs: NOW,
        spawnToken: 'old',
        runtime: agentSessionRuntimeIncarnation()
      }
    })
  )
  return {
    ...value,
    providerHandleChain: value.providerHandleChain.map((link) => ({
      ...link,
      handle: claudeProviderHandle(`${id}-provider`, null)
    }))
  }
}
async function seed(id: string, running = true): Promise<void> {
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId: id,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle(`${id}-provider`, null)
    },
    database: openTestJournalHostDatabase(root),
    now: () => savedAt
  })
  await journal.appendItem(
    { provider: 'claude', sessionId: `${id}-provider`, uuid: 'turn' },
    {
      kind: 'turn',
      turnId: 'turn',
      state: running ? 'running' : 'completed',
      startedAt: savedAt,
      ...(running ? {} : { outcome: 'success' as const })
    },
    { fence: 7 }
  )
  await journal.close()
}
async function create(records: AgentSessionRecord[]) {
  await seedTestAgentSessionRecordStore(root, { records })
  const store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      open: async () => ({ reportedOptions: { model: '' } }),
      acquire: vi.fn(),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn()
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'new',
    now: () => NOW,
    probeOwner: async () => ({ outcome: 'indeterminate', reason: 'unproved' })
  })
  return host
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-r3-host-'))
  setStructuredJournalReadiness(() => false)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  setStructuredJournalReadiness(() => false)
  await host?.flushAllStreamedEvents()
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

it.each([
  'live-unproved',
  'foreign',
  'conflicted',
  'failed',
  'ended',
  'changed-during-await'
] as const)(
  'keeps cold listing and both opened consumers under current %s owner evidence',
  async (kind) => {
    let initial = record()
    if (kind === 'foreign') {
      initial = {
        ...initial,
        lease: {
          ...initial.lease,
          ownerProcess: { ...initial.lease.ownerProcess!, hostId: 'foreign' }
        }
      }
    }
    if (kind === 'conflicted' || kind === 'changed-during-await') {
      initial = { ...initial, lease: { ...initial.lease, claimStatus: 'conflicted' } }
    }
    if (kind === 'ended') {
      initial = {
        ...initial,
        lease: {
          ...initial.lease,
          ownerProcess: { ...initial.lease.ownerProcess!, runtime: 'previous-runtime' }
        }
      }
    }
    const current = await create([initial])
    await seed(sessionId)
    if (kind === 'failed' || kind === 'live-unproved') {
      vi.spyOn(current.deps.store, 'reconcileOnRestart').mockRejectedValue(
        new Error('bookkeeping unavailable')
      )
    }
    if (kind === 'ended') {
      current.deps.probeOwner = async () => ({ outcome: 'pid-absent' })
    }
    if (kind === 'changed-during-await') {
      const reconcile = current.deps.store.reconcileOnRestart.bind(current.deps.store)
      vi.spyOn(current.deps.store, 'reconcileOnRestart').mockImplementation(async (args) => {
        await reconcile(args)
        await current.deps.store.transitionHandoff(sessionId, (r) => ({
          ...r,
          lease: {
            ...r.lease,
            claimStatus: 'released',
            unreconciled: false,
            handoffStage: null,
            ownerProcess: null,
            reservedSpawnToken: null,
            deathEvidence: {
              kind: 'pid-absent',
              detail: 'runtime ended',
              observedAt: NOW,
              ownerFence: 7,
              runtimeEnd: 'crash'
            }
          }
        }))
        return new Map([[sessionId, current.deps.store.getRecord(sessionId)!]])
      })
    }
    const trusted: AgentSessionStatusSummary[] = []
    const broadcast: AgentSessionStatusSummary[] = []
    current.deps.statusSink = { publish: (r) => trusted.push(r), forget: () => {} }
    current.subscribeStatus({
      id: 'both',
      emit: (e) => {
        if (e.type === 'status') {
          broadcast.push(e.session)
        }
      }
    })
    const opened = vi.spyOn(AgentSessionJournal.prototype, 'open')
    await current.restoreReadableSessions([sessionId])
    expect(opened).not.toHaveBeenCalled()
    const ended = kind === 'ended' || kind === 'changed-during-await'
    for (const rows of [trusted, broadcast]) {
      expect(rows.at(-1)).toMatchObject({
        status: 'idle',
        turnOutcome: ended ? 'cancellation' : 'unconfirmed',
        statusStartedAt: savedAt
      })
      expect(rows.at(-1)?.restoredInterruption).toBe(ended ? true : undefined)
    }
    await current.journalSnapshot(sessionId)
    expect(opened).toHaveBeenCalledOnce()
    for (const rows of [trusted, broadcast]) {
      expect(rows.at(-1)).toMatchObject({
        status: 'idle',
        turnOutcome: ended ? 'cancellation' : 'unconfirmed',
        statusStartedAt: savedAt
      })
      expect(rows.at(-1)?.restoredInterruption).toBe(ended ? true : undefined)
    }
  }
)

it.each([32, 320])(
  'bounds real host registry wakes and retires exhausted discovery for %i known/foreign chats',
  async (count) => {
    const known = Array.from({ length: count }, (_, i) => `known-row-${i}`)
    const foreign = Array.from({ length: count }, (_, i) => `foreign-row-${i}`)
    const target = 'unknown-after-population'
    const retry = 'foreign-later-proved'
    const visible = 'visible-unknown'
    const recent = 'recent-unknown'
    const records = [...known, ...foreign, target, retry, visible, recent].map((id) => {
      const r = record(id)
      return {
        ...r,
        lease: {
          ...r.lease,
          claimStatus: 'released' as const,
          unreconciled: false,
          ownerProcess: null,
          reservedSpawnToken: null
        }
      }
    })
    for (const r of records.filter((r) => r.sessionId.startsWith('foreign'))) {
      r.lease = {
        ...record(r.sessionId).lease,
        ownerProcess: { ...record(r.sessionId).lease.ownerProcess!, hostId: 'foreign' }
      }
    }
    records.find((r) => r.sessionId === recent)!.updatedAt = NOW
    const current = await create(records)
    await current.setSessionTabVisibility(visible, true, 'visible-tab')
    const classified: string[] = []
    current.deps.statusSink = { publish: (row) => classified.push(row.sessionId), forget: () => {} }
    for (const id of [...known, ...foreign, target, retry, visible, recent]) {
      await seed(id, !known.includes(id))
    }
    const { db } = current.deps.journalDatabase
    db.prepare(
      'UPDATE journal_sessions SET open_turn_id = NULL, open_turn_since = NULL WHERE session_id IN (?,?,?,?)'
    ).run(target, retry, visible, recent)
    let taskWork = 0
    let maxTaskWork = 0
    let resetPending = false
    const mark = () => {
      taskWork++
      maxTaskWork = Math.max(maxTaskWork, taskWork)
      if (!resetPending) {
        resetPending = true
        setImmediate(() => {
          taskWork = 0
          resetPending = false
        })
      }
    }
    const original = current.deps.store.getRecord
    const owners = vi.spyOn(current.deps.store, 'getRecord').mockImplementation((id) => {
      mark()
      return original(id)
    })
    const tabId = current.deps.store.getSessionTabId.bind(current.deps.store)
    const ordered = vi.spyOn(current.deps.store, 'getSessionTabId').mockImplementation((id) => {
      mark()
      return tabId(id)
    })
    const sql = vi.spyOn(db, 'prepare')
    const advance = vi.spyOn(JournalLegacyRestInitializer.prototype, 'advance')
    setStructuredAgentSessionHost(current)
    const foreground = beginStructuredJournalForeground()
    setStructuredJournalReadiness(() => true)
    current.advanceLegacyRest()
    expect(readJournalRestFacts(db, target)?.known).toBe(false)
    foreground()
    await advance.mock.results.findLast((result) => result.value)?.value
    expect(readJournalRestFacts(db, target)?.known).toBe(true)
    expect(readJournalRestFacts(db, retry)?.known).toBe(false)
    expect(classified).toEqual([visible, recent, target])
    expect(maxTaskWork).toBeLessThanOrEqual(34)
    expect(ordered).toHaveBeenCalledTimes(records.length)
    const exhausted = {
      probes: sql.mock.calls.length,
      owners: owners.mock.calls.length,
      ordered: ordered.mock.calls.length
    }
    for (let i = 0; i < 3; i++) {
      beginStructuredJournalForeground()()
      await advance.mock.results.findLast((result) => result.value)?.value
    }
    expect({
      probes: sql.mock.calls.length,
      owners: owners.mock.calls.length,
      ordered: ordered.mock.calls.length
    }).toEqual(exhausted)
    await current.deps.store.reconcileOnRestart({
      now: NOW,
      probe: async () => ({ outcome: 'pid-absent' })
    })
    await advance.mock.results.findLast((result) => result.value)?.value
    expect(readJournalRestFacts(db, retry)?.known).toBe(true)
    expect(ordered).toHaveBeenCalledTimes(records.length)
  }
)
