vi.mock('../agent-session-journal/journal-legacy-rest-worker', async () => {
  const { InProcessLegacyRestWorker } =
    await import('../agent-session-journal/journal-legacy-rest-replay-test-support')
  return { JournalLegacyRestWorker: InProcessLegacyRestWorker }
})

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

it.each(['live-unproved', 'foreign', 'conflicted', 'ended', 'changed-during-await'] as const)(
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
    if (kind === 'live-unproved') {
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
    expect(ordered).toHaveBeenCalledTimes(records.length + 1)
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
    expect(ordered).toHaveBeenCalledTimes(records.length + 1)
  }
)

it('publishes committed legacy initialization after ordinary open at its original clock', async () => {
  const completed = 'legacy-completed-before-background'
  const unfinished = 'legacy-unfinished-before-background'
  const negatives = ['legacy-foreign', 'legacy-conflicted', 'legacy-unproved']
  const ids = [completed, unfinished, ...negatives]
  const records = ids.map((id) => {
    const r = record(id)
    if (id === completed || id === unfinished) {
      return {
        ...r,
        lease: {
          ...r.lease,
          claimStatus: 'released' as const,
          unreconciled: false,
          ownerProcess: null,
          reservedSpawnToken: null,
          deathEvidence: {
            kind: 'pid-absent' as const,
            detail: 'previous runtime ended',
            observedAt: NOW,
            ownerFence: 7,
            runtimeEnd: 'crash' as const
          }
        }
      }
    }
    return {
      ...r,
      lease: {
        ...r.lease,
        ...(id === negatives[0]
          ? { ownerProcess: { ...r.lease.ownerProcess!, hostId: 'foreign' } }
          : id === negatives[1]
            ? { claimStatus: 'conflicted' as const }
            : {})
      }
    }
  })
  const current = await create(records)
  current.deps.probeOwner = async (r) =>
    r.sessionId === negatives[0]
      ? { outcome: 'identity-matched', matchedOn: ['process-start-time'] }
      : { outcome: 'indeterminate', reason: 'unproved' }
  const transition = current.deps.store.transitionHandoff.bind(current.deps.store)
  const release = vi
    .spyOn(current.deps.store, 'transitionHandoff')
    .mockImplementation((id, apply) =>
      id === negatives[2]
        ? Promise.reject(new Error('agent_session_ownership_unknown'))
        : transition(id, apply)
    )
  const { db } = current.deps.journalDatabase
  for (const id of ids) {
    await seed(id, id === unfinished)
    db.prepare(
      'UPDATE journal_sessions SET open_turn_id = NULL, open_turn_since = NULL WHERE session_id = ?'
    ).run(id)
  }
  const rows = db.prepare(
    'SELECT seq, ts, row_json FROM journal_rows WHERE session_id = ? ORDER BY seq'
  )
  const originalRows = rows.all(completed)
  const trusted: AgentSessionStatusSummary[] = []
  const broadcast: AgentSessionStatusSummary[] = []
  current.deps.statusSink = { publish: (row) => trusted.push(row), forget: () => {} }
  current.subscribeStatus({
    id: 'initialization-both',
    emit: (event) => {
      if (event.type === 'status') {
        broadcast.push(event.session)
      }
    }
  })
  const opened = vi.spyOn(AgentSessionJournal.prototype, 'open')
  const advance = vi.spyOn(JournalLegacyRestInitializer.prototype, 'advance')
  const latest = (events: AgentSessionStatusSummary[], id: string) =>
    events.findLast((event) => event.sessionId === id)
  await current.restoreReadableSessions(ids)
  expect(opened).not.toHaveBeenCalled()
  for (const events of [trusted, broadcast]) {
    for (const id of ids) {
      expect(latest(events, id)?.status, id).toBeNull()
      expect(latest(events, id)?.turnOutcome).toBeUndefined()
      expect(latest(events, id)?.statusStartedAt).toBeUndefined()
      expect(latest(events, id)?.restoredInterruption).toBeUndefined()
    }
  }
  expect(release).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledWith(negatives[2], expect.any(Function))
  for (const id of negatives) {
    expect(current.deps.store.replacedRuntime(id), id).toBeUndefined()
    expect(current.deps.store.getRecord(id)?.lease, id).toMatchObject({
      runtimeFence: 7,
      handoffStage: 'recovering',
      claimStatus: records.find((r) => r.sessionId === id)!.lease.claimStatus,
      ownerProcess: records.find((r) => r.sessionId === id)!.lease.ownerProcess,
      deathEvidence: null
    })
  }
  expect(readJournalRestFacts(db, completed)?.known).toBe(false)
  await current.journalSnapshot(completed)
  expect(opened).toHaveBeenCalledOnce()
  expect(readJournalRestFacts(db, completed)).toMatchObject({ known: true, openTurn: null })
  expect(rows.all(completed)).toEqual(originalRows)
  for (const events of [trusted, broadcast]) {
    expect(latest(events, completed)?.status).toBeNull()
    expect(latest(events, completed)?.turnOutcome).toBeUndefined()
    expect(latest(events, completed)?.statusStartedAt).toBeUndefined()
  }
  setStructuredJournalReadiness(() => true)
  current.advanceLegacyRest()
  await advance.mock.results.findLast((result) => result.value)?.value
  for (const events of [trusted, broadcast]) {
    expect(latest(events, completed)).toMatchObject({
      status: 'idle',
      statusStartedAt: savedAt,
      updatedAt: savedAt
    })
    expect(latest(events, completed)?.turnOutcome).toBeUndefined()
    expect(latest(events, completed)?.restoredInterruption).toBeUndefined()
    expect(latest(events, unfinished)).toMatchObject({
      status: 'idle',
      turnOutcome: 'cancellation',
      restoredInterruption: true,
      statusStartedAt: savedAt
    })
    for (const id of negatives) {
      expect(latest(events, id)?.status, id).toBeNull()
      expect(latest(events, id)?.turnOutcome).toBeUndefined()
      expect(latest(events, id)?.restoredInterruption).toBeUndefined()
      expect(readJournalRestFacts(db, id)?.known).toBe(false)
    }
  }
  expect(rows.all(completed)).toEqual(originalRows)
  expect(opened).toHaveBeenCalledOnce()
  for (const action of [
    'acquire',
    'dispatch',
    'cancelTurn',
    'answerPrompt',
    'setOption'
  ] as const) {
    expect(current.deps.adapter[action]).not.toHaveBeenCalled()
  }
  const before = { trusted: [...trusted], broadcast: [...broadcast] }
  current.advanceLegacyRest()
  await advance.mock.results.findLast((result) => result.value)?.value
  expect({ trusted, broadcast }).toEqual(before)
})

it('hands committed priorities and retiring foreground wakes to the same background lifetime', async () => {
  const shown = 'shown-after-capture'
  const recent = 'recent-hidden'
  const hidden = 'hidden-after-capture'
  const ties = ['stable-first', 'stable-second']
  const late = 'late-committed'
  const beforeA = 'updated-before-first-pull'
  const beforeB = 'shown-before-first-pull'
  const eligible = [shown, recent, hidden, ...ties]
  const ids = [
    beforeA,
    beforeB,
    ...eligible,
    late,
    ...Array.from({ length: 56 }, (_, i) => `discovery-${i}`)
  ]
  const records = ids.map((id) => {
    const r = record(id)
    return {
      ...r,
      updatedAt: id === recent || id === beforeB ? 200 : id === hidden ? 300 : 100,
      lease: {
        ...r.lease,
        claimStatus: 'released' as const,
        unreconciled: false,
        ownerProcess: null,
        reservedSpawnToken: null
      }
    }
  })
  const current = await create(records)
  const store = current.deps.store
  const { db } = current.deps.journalDatabase
  const clear = db.prepare(
    'UPDATE journal_sessions SET open_turn_id = NULL, open_turn_since = NULL WHERE session_id = ?'
  )
  for (const id of [beforeA, beforeB, ...eligible]) {
    await seed(id)
    clear.run(id)
  }
  const published: string[] = []
  current.deps.statusSink = { publish: (row) => published.push(row.sessionId), forget: () => {} }
  const captured = Promise.withResolvers<void>()
  const snapshots: string[] = []
  let discovering = false
  let releaseDiscovery = () => {}
  const tabId = store.getSessionTabId.bind(store)
  const ordered = vi.spyOn(store, 'getSessionTabId').mockImplementation((id) => {
    const result = tabId(id)
    if (discovering && snapshots.length < ids.length) {
      snapshots.push(id)
      if (snapshots.length === ids.length) {
        releaseDiscovery = beginStructuredJournalForeground()
        captured.resolve()
      }
    }
    return result
  })
  const iterate = store.iterateRecords.bind(store)
  const scans = vi.spyOn(store, 'iterateRecords').mockImplementation(() => {
    discovering = true
    return iterate()
  })
  const advance = vi.spyOn(JournalLegacyRestInitializer.prototype, 'advance')
  setStructuredAgentSessionHost(current)
  await store.setSessionTabVisibility(hidden, true, 'hidden-tab')
  await store.setSessionTabVisibility(beforeB, true, 'before-b-tab')
  await store.setSessionTabVisibility(beforeA, true, 'before-a-tab')
  const beforeClock = vi.spyOn(Date, 'now').mockReturnValue(NOW + 2)
  try {
    await store.setConversationName(beforeA, 'new title before discovery')
  } finally {
    beforeClock.mockRestore()
  }
  expect(store.getRecord(beforeA)?.updatedAt).toBe(NOW + 2)
  expect(scans).not.toHaveBeenCalled()
  expect(ordered).toHaveBeenCalledTimes(3)
  // Make only this first wait already due, so its fulfilled continuation precedes release.
  const initialDue = vi.spyOn(performance, 'now').mockReturnValueOnce(Number.MAX_SAFE_INTEGER)
  try {
    setStructuredJournalReadiness(() => true)
  } finally {
    initialDue.mockRestore()
  }
  const retiring = advance.mock.results.at(-1)?.value
  expect(retiring).toBeInstanceOf(Promise)
  const finish = beginStructuredJournalForeground()
  let releasedLifetime: Promise<void> | undefined
  let stopWatching = () => {}
  try {
    // The fulfilled wait continuation observes the hold before this finite release runs.
    await Promise.resolve().then(() => {
      finish()
      releasedLifetime = advance.mock.results.at(-1)?.value
    })
    expect(releasedLifetime).toBe(retiring)
    await captured.promise
    expect(snapshots).toEqual(ids)
    expect(ordered).toHaveBeenCalledTimes(ids.length + 3)
    expect(published).toEqual([])
    await store.setSessionTabVisibility(shown, true, 'shown-tab')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW + 1)
    try {
      await store.setConversationName(hidden, 'committed priority update')
    } finally {
      clock.mockRestore()
    }
    await store.setSessionTabVisibility(hidden, false)
    // Reverse notification order must not reverse original equal-priority discovery ties.
    await store.showSessionTabs([ties[1], ties[0]])
    expect(store.getRecord(hidden)?.updatedAt).toBe(NOW + 1)
    expect(ordered).toHaveBeenCalledTimes(ids.length + 7)
    releaseDiscovery()
    await advance.mock.results.at(-1)?.value
    expect(published).toEqual([beforeA, beforeB, shown, ...ties, hidden, recent])
    for (const id of [beforeA, beforeB, ...eligible]) {
      expect(readJournalRestFacts(db, id)).toMatchObject({
        known: true,
        openTurn: { since: savedAt }
      })
    }
    expect(scans).toHaveBeenCalledOnce()
    expect(ordered).toHaveBeenCalledTimes(ids.length + 13)
    // This already-discovered record had no source. A real new source is now committed.
    await seed(late, false)
    clear.run(late)
    let committedLifetime: Promise<void> | undefined
    stopWatching = store.onTabMembershipChanged((id) => {
      if (id === late) {
        committedLifetime = advance.mock.results.at(-1)?.value
      }
    })
    // Queue the store commit before the empty run's fulfilled wait. Its committed listener
    // runs after that run returns but before catch/finally clears the running lifetime.
    const committed = store.setSessionTabVisibility(late, true, 'late-tab')
    const exhaustedDue = vi.spyOn(performance, 'now').mockReturnValueOnce(Number.MAX_SAFE_INTEGER)
    try {
      current.advanceLegacyRest()
    } finally {
      exhaustedDue.mockRestore()
    }
    const exhausted = advance.mock.results.at(-1)?.value
    expect(exhausted).toBeInstanceOf(Promise)
    await committed
    expect(committedLifetime).toBe(exhausted)
    await exhausted
    expect(published).toEqual([beforeA, beforeB, shown, ...ties, hidden, recent, late])
    expect(readJournalRestFacts(db, late)).toMatchObject({ known: true, openTurn: null })
    expect(scans).toHaveBeenCalledOnce()
    expect(ordered).toHaveBeenCalledTimes(ids.length + 14)
  } finally {
    finish()
    releaseDiscovery()
    stopWatching()
  }
})
