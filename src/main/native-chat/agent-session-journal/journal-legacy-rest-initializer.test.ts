import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { WorkBucket } from './journal-work-bucket'
import { JournalLegacyRestInitializer } from './journal-legacy-rest-initializer'
import {
  JournalStructuralScratch,
  type JournalStructuralCheckpoint
} from './journal-structural-scratch'
import { openAgentSessionJournal } from './journal-store-factory'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { readJournalRestFacts } from './journal-row-table'

let root: string
const sessionId = 'legacy-upgrade'
const since = 1_800_000_000_000
const identity = (turnId: string) =>
  ({ provider: 'codex', threadId: 'thread', turnId, ordinal: 0 }) as const
const open = (now = () => since) =>
  openAgentSessionJournal({
    identity: {
      sessionId,
      workspaceId: 'workspace',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread')
    },
    database: openTestJournalHostDatabase(root),
    now
  })
const unknown = () =>
  openTestJournalHostDatabase(root)
    .db.prepare(
      'UPDATE journal_sessions SET open_turn_id = NULL, open_turn_since = NULL WHERE session_id = ?'
    )
    .run(sessionId)
const facts = () => readJournalRestFacts(openTestJournalHostDatabase(root).db, sessionId)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-legacy-rest-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

it.each([64, 640])(
  'resumes committed structural progress at %i rows, preserving aliases, creation order and raw keys',
  async (size) => {
    const journal = await open()
    await journal.appendItem(
      identity('older'),
      { kind: 'turn', turnId: 'older', state: 'completed', outcome: 'success' },
      { fence: 1 }
    )
    const rawId = '\0\ud800\nraw'
    const body = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'retained exact payload' }]
    } as const
    await journal.appendSubmission({
      clientMessageId: rawId,
      body,
      payloadFingerprint: agentSessionSendBodyFingerprint(sessionId, body),
      fence: 1,
      handoverRecorded: true
    })
    const echo = { ...identity('newer'), ordinal: 1 }
    await journal.appendItem(echo, body, { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    await journal.appendLifecycleBatch({
      settlementId: 'newer-cut',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          identity: identity('newer'),
          body: {
            kind: 'turn',
            turnId: 'newer',
            userItemId: agentJournalItemKey(echo),
            startedAt: since,
            state: 'interrupted',
            outcome: 'cancellation'
          }
        }
      ]
    })
    await journal.appendItem(
      identity('older'),
      { kind: 'turn', turnId: 'older', state: 'completed', outcome: 'success' },
      { fence: 1 }
    )
    const command = { ...identity('compact'), ordinal: 1 }
    await journal.appendItem(
      command,
      {
        kind: 'message',
        role: 'user',
        command: { name: 'compact' },
        blocks: [{ type: 'text', text: '/compact' }]
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await journal.appendItem(
      identity('compact'),
      {
        kind: 'turn',
        turnId: 'compact',
        state: 'running',
        userItemId: agentJournalItemKey(command)
      },
      { fence: 1 }
    )
    await journal.appendItem(
      identity('compact'),
      { kind: 'status', text: 'compacted' },
      { fence: 1 }
    )
    await journal.appendLifecycleBatch({
      settlementId: 'temporary-turn',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          identity: identity('removed'),
          body: { kind: 'turn', turnId: 'removed', state: 'running' }
        },
        { kind: 'tombstone', identity: identity('removed') }
      ]
    })
    await journal.appendItem(
      identity('nested'),
      { kind: 'turn', turnId: 'nested', state: 'running' },
      {
        fence: 1,
        agentId: 'helper',
        producerKind: 'subagent',
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    )
    for (let i = 0; i < size; i++) {
      await journal.appendItem(
        { ...identity('newer'), ordinal: 2 },
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `stream ${i}` }] },
        { fence: 1 }
      )
    }
    const tip = journal.cursor().sequence
    const expected = journal.restFact()
    expect(expected).toEqual({ itemId: agentJournalItemKey(identity('newer')), since })
    await journal.close()
    unknown()
    const failed = vi.fn()
    const published = vi.fn((_id, actual) => {
      expect(facts()).toEqual(actual)
    })
    const make = () =>
      new JournalLegacyRestInitializer({
        database: openTestJournalHostDatabase(root),
        candidates: () => [sessionId],
        owner: () => 'ended-fence-1',
        initialized: published,
        failed
      })
    const scratch = new JournalStructuralScratch(join(root, 'journal-rest-upgrade-scratch.db'))
    const savedItems = scratch.map('items')
    expect(scratch.load()).toBeUndefined()
    expect(savedItems.size).toBe(0)
    const first = make()
    await first.advance(() => !scratch.load<JournalStructuralCheckpoint>() || savedItems.size === 0)
    expect(facts()?.known).toBe(false)
    first.close()
    const checkpoint = scratch.load<JournalStructuralCheckpoint>()!
    expect(checkpoint.sessionId).toBe(sessionId)
    expect(checkpoint.cursor).toBeGreaterThan(0)
    expect(checkpoint.cursor).toBeLessThan(size)
    expect(scratch.map('items').size).toBeGreaterThan(0)
    scratch.close()
    closeTestJournalHostDatabases()
    const database = openTestJournalHostDatabase(root)
    const prepare = database.db.prepare.bind(database.db)
    const reads: unknown[][] = []
    const sql = vi.spyOn(database.db, 'prepare').mockImplementation((query) => {
      const statement = prepare(query)
      if (query.includes('ORDER BY seq ASC LIMIT') && !vi.isMockFunction(statement.all)) {
        const all = statement.all.bind(statement)
        vi.spyOn(statement, 'all').mockImplementation((...args) => {
          reads.push(args)
          return all(...args)
        })
      }
      return statement
    })
    const resumed = make()
    await resumed.advance(() => true)
    expect(failed.mock.calls.map(([, error]) => error?.stack)).toEqual([])
    expect(published).toHaveBeenCalledOnce()
    expect(facts()?.openTurn).toEqual(expected)
    expect(reads[0]?.[2]).toBe(checkpoint.cursor)
    expect(new Set(reads.map((args) => args[2])).size).toBe(tip - checkpoint.cursor + 1)
    expect(reads.every((args) => Number(args[2]) >= checkpoint.cursor)).toBe(true)
    const count = reads.length
    await resumed.advance(() => true)
    expect(reads).toHaveLength(count)
    resumed.close()
    sql.mockRestore()
    const reopened = await open()
    expect(reopened.restFact()).toEqual(expected)
    expect(reopened.submission(rawId)?.providerItemId).toBe(agentJournalItemKey(echo))
    await reopened.close()
  }
)

it('preserves equal-time claimant order through a dispatch checkpoint and implicit echo', async () => {
  const journal = await open(() => 100)
  const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'same' }] } as const
  for (const clientMessageId of ['A', 'B']) {
    await journal.appendSubmission({
      clientMessageId,
      body,
      payloadFingerprint: agentSessionSendBodyFingerprint(sessionId, body),
      handoverRecorded: true,
      fence: 1
    })
  }
  await journal.resolveDispatch({
    clientMessageId: 'A',
    fence: 1,
    state: 'pending',
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  const dispatched = journal.cursor().sequence
  for (let i = 0; i < 32; i++) {
    await journal.appendItem(
      { ...identity('prefix'), ordinal: 1 },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `prefix ${i}` }] },
      { fence: 1 }
    )
  }
  const echo = { ...identity('echo'), ordinal: 1 }
  await journal.appendItem(echo, body, { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
  const echoed = journal.cursor().sequence
  await journal.appendItem(
    identity('echo'),
    {
      kind: 'turn',
      turnId: 'echo',
      state: 'completed',
      outcome: 'success',
      startedAt: 100,
      userItemId: agentJournalItemKey(echo)
    },
    { fence: 1 }
  )
  await journal.resolveDispatch({
    clientMessageId: 'B',
    fence: 1,
    state: 'rejected',
    reason: 'not sent'
  })
  expect(journal.submission('A')?.providerItemId).toBe(agentJournalItemKey(echo))
  expect(journal.submission('B')?.providerItemId).toBeNull()
  expect(journal.restFact()).toBeNull()
  expect(facts()).toMatchObject({ known: true, openTurn: null })
  await journal.close()
  unknown()
  const failed = vi.fn()
  const published = vi.fn()
  const make = () =>
    new JournalLegacyRestInitializer({
      database: openTestJournalHostDatabase(root),
      candidates: () => [sessionId],
      owner: () => 'ended',
      initialized: published,
      failed
    })
  const scratch = new JournalStructuralScratch(join(root, 'journal-rest-upgrade-scratch.db'))
  const first = make()
  await first.advance(() => (scratch.load<JournalStructuralCheckpoint>()?.cursor ?? 0) < dispatched)
  first.close()
  const checkpoint = scratch.load<JournalStructuralCheckpoint>()!
  expect(checkpoint.cursor).toBeGreaterThanOrEqual(dispatched)
  expect(checkpoint.cursor).toBeLessThan(echoed)
  expect(
    Array.from(
      scratch.map<string, { ordinal: number; fingerprint: string }>('selection:submissionSources')
    )
      .filter(([, value]) => value.fingerprint === agentSessionSendBodyFingerprint(sessionId, body))
      .sort(([, a], [, b]) => a.ordinal - b.ordinal)
      .map(([raw]) => raw)
  ).toEqual(['A', 'B'])
  scratch.close()
  closeTestJournalHostDatabases()
  const resumed = make()
  await resumed.advance(() => true)
  resumed.close()
  expect(failed).not.toHaveBeenCalled()
  expect(published).toHaveBeenCalledOnce()
  expect(published.mock.calls[0]?.[1]).toMatchObject({ known: true, openTurn: null })
  expect(facts()).toMatchObject({ known: true, openTurn: null })
  const reopened = await open(() => 100)
  expect(reopened.restFact()).toBeNull()
  expect(reopened.submission('A')?.providerItemId).toBe(agentJournalItemKey(echo))
  expect(reopened.submission('B')?.providerItemId).toBeNull()
  await reopened.close()
})

it.each(['owner', 'tip', 'pair', 'epoch', 'core-failure', 'newer', 'gap'])(
  'leaves newer authority and unsupported/failed evidence untouched: %s',
  async (race) => {
    const journal = await open()
    await journal.appendItem(
      identity('cut'),
      { kind: 'turn', turnId: 'cut', state: 'running', startedAt: since },
      { fence: 1 }
    )
    await journal.close()
    unknown()
    const database = openTestJournalHostDatabase(root)
    let owner: string | null = 'ended'
    const publish = vi.fn()
    const failed = vi.fn()
    let checks = 0
    const initializer = new JournalLegacyRestInitializer({
      database,
      candidates: () => [sessionId],
      owner: () => {
        if (++checks === 2) {
          if (race === 'owner') {
            owner = null
          }
          if (race === 'tip') {
            database.db
              .prepare('DELETE FROM journal_rows WHERE session_id = ? AND seq = 2')
              .run(sessionId)
          }
          if (race === 'epoch') {
            database.db
              .prepare('UPDATE journal_sessions SET epoch = ? WHERE session_id = ?')
              .run('replacement-wins', sessionId)
          }
          if (race === 'pair') {
            database.db
              .prepare('UPDATE journal_sessions SET open_turn_since = 0 WHERE session_id = ?')
              .run(sessionId)
          }
        }
        return owner
      },
      initialized: publish,
      failed
    })
    const transaction = database.transaction.bind(database)
    if (race === 'core-failure') {
      vi.spyOn(database, 'transaction').mockImplementationOnce((run) =>
        transaction((db) => {
          run(db)
          throw new Error('failed COMMIT')
        })
      )
    }
    if (race === 'newer') {
      database.db
        .prepare(
          "UPDATE journal_rows SET row_json = json_set(row_json, '$.v', 999) WHERE session_id = ? AND seq = 2"
        )
        .run(sessionId)
    }
    if (race === 'gap') {
      database.db
        .prepare('DELETE FROM journal_rows WHERE session_id = ? AND seq = 1')
        .run(sessionId)
    }
    await initializer.advance(() => true)
    initializer.close()
    expect(publish).not.toHaveBeenCalled()
    expect(facts()?.known).toBe(race === 'pair')
    if (['core-failure', 'newer', 'gap'].includes(race)) {
      expect(failed).toHaveBeenCalledOnce()
    }
  }
)

it('bounds independent linked request retirement and checkpoint replay at N and 10N', async () => {
  const measurements = []
  for (const count of [16, 160]) {
    let updates = 0
    let depth = 0
    let indexOperations = 0
    const originalUpdate = WorkBucket.prototype.update
    const update = vi
      .spyOn(WorkBucket.prototype, 'update')
      .mockImplementation(function (key, value) {
        updates++
        depth++
        try {
          return originalUpdate.call(this, key, value)
        } finally {
          depth--
        }
      })
    const keyed = (['get', 'set', 'delete'] as const).map((method) => {
      const original = Map.prototype[method]
      return vi.spyOn(Map.prototype, method).mockImplementation(function (...args) {
        if (depth) {
          indexOperations++
        }
        return Reflect.apply(original, this, args)
      })
    })
    const execPrototype = Object.getPrototypeOf(openTestJournalHostDatabase(root).db)
    const originalExec = execPrototype.exec
    const allExec = vi.spyOn(execPrototype, 'exec')
    const allSql = vi.spyOn(Object.getPrototypeOf(openTestJournalHostDatabase(root).db), 'prepare')
    const journal = await open()
    for (let i = 0; i < count; i++) {
      await journal.appendSubmission({
        clientMessageId: `linked-${count}-${i}`,
        payloadFingerprint: `${count}-${i}`,
        body: { kind: 'message', role: 'user', blocks: [] },
        fence: 1,
        handoverRecorded: true
      })
      await journal.appendItem(
        identity(`linked-${count}-${i}`),
        {
          kind: 'turn',
          turnId: `linked-${count}-${i}`,
          userItemId: `orca:linked-${count}-${i}`,
          state: 'running',
          startedAt: since
        },
        { fence: 1 }
      )
    }
    const expectedAt = new Map([[journal.cursor().sequence, journal.restFact()]])
    const prefix = journal.cursor().sequence
    for (let i = 0; i < 32; i++) {
      await journal.appendItem(
        { ...identity('checkpoint-gap'), ordinal: 1 },
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `${i}` }] },
        { fence: 1 }
      )
    }
    expectedAt.set(journal.cursor().sequence, journal.restFact())
    let mapVisits = 0
    const values = Map.prototype.values
    const visits = vi.spyOn(Map.prototype, 'values').mockImplementation(function* () {
      for (const value of values.call(this)) {
        mapVisits++
        yield value
      }
    })
    for (let i = 0; i < count; i++) {
      await journal.appendItem(
        identity(`linked-${count}-${i}`),
        {
          kind: 'turn',
          turnId: `linked-${count}-${i}`,
          userItemId: `orca:linked-${count}-${i}`,
          state: 'completed',
          outcome: 'success',
          startedAt: since
        },
        { fence: 1 }
      )
      const expected =
        i + 1 === count
          ? null
          : {
              itemId: agentJournalItemKey(identity(`linked-${count}-${i + 1}`)),
              since
            }
      expect(journal.restFact()).toEqual(expected)
      expect(facts()?.openTurn).toEqual(expected)
      expectedAt.set(journal.cursor().sequence, expected)
    }
    visits.mockRestore()
    expect(journal.restFact()).toBeNull()
    const tip = journal.cursor().sequence
    await journal.close()
    unknown()
    const database = openTestJournalHostDatabase(root)
    const scratch = new JournalStructuralScratch(join(root, 'journal-rest-upgrade-scratch.db'))
    const initialized = vi.fn()
    const failed = vi.fn()
    const make = () =>
      new JournalLegacyRestInitializer({
        database,
        candidates: () => [sessionId],
        owner: () => 'ended',
        initialized,
        failed
      })
    const first = make()
    await first.advance(() => (scratch.load<JournalStructuralCheckpoint>()?.cursor ?? 0) < prefix)
    first.close()
    const checkpoint = scratch.load<JournalStructuralCheckpoint>()!
    const cursor = checkpoint.cursor
    expect(checkpoint.rest.active.head?.fact).toEqual(expectedAt.get(prefix))
    expect(cursor).toBeGreaterThanOrEqual(prefix)
    expect(cursor).toBeLessThan(tip)
    const resumed = make()
    const resumedCursors: number[] = []
    const prepare = database.db.prepare.bind(database.db)
    const rowStatements = new WeakSet<object>()
    const rowSql = vi.spyOn(database.db, 'prepare').mockImplementation((query) => {
      const statement = prepare(query)
      if (query.includes('ORDER BY seq ASC LIMIT') && !rowStatements.has(statement)) {
        rowStatements.add(statement)
        const all = statement.all.bind(statement)
        vi.spyOn(statement, 'all').mockImplementation((...args) => {
          resumedCursors.push(Number(args[2]))
          return all(...args)
        })
      }
      return statement
    })
    const committedHeads: JournalStructuralCheckpoint[] = []
    allExec.mockImplementation(function (query) {
      const result = originalExec.call(this, query)
      if (String(query).trim() === 'COMMIT') {
        const saved = scratch.load<JournalStructuralCheckpoint>()
        if (saved && !saved.pending && !('cleanup' in saved)) {
          committedHeads.push(saved)
        }
      }
      return result
    })
    await resumed.advance(() => true)
    const structuralVisits = allSql.mock.calls.filter(([query]) =>
      String(query).includes('SELECT id,key,value FROM relations')
    ).length
    const mainRows = new Set(resumedCursors).size
    expect(resumedCursors[0]).toBe(cursor)
    expect(resumedCursors.every((after) => after >= cursor)).toBe(true)
    const structuralSql = allSql.mock.calls.filter(([query]) =>
      /relations|checkpoint|context_clears/.test(String(query))
    ).length
    for (const saved of committedHeads) {
      const expected =
        saved.cursor <= prefix + 32 ? expectedAt.get(prefix) : expectedAt.get(saved.cursor)
      expect(expected).not.toBeUndefined()
      expect(saved.rest.active.head?.fact ?? null).toEqual(expected)
    }
    expect(committedHeads.length).toBeGreaterThan(0)
    const structuralExec = allExec.mock.calls.reduce(
      (total, [query]) =>
        total +
        String(query)
          .split(';')
          .filter((part) => part.trim()).length,
      0
    )
    rowSql.mockRestore()
    allSql.mockRestore()
    allExec.mockRestore()
    update.mockRestore()
    keyed.forEach((spy) => spy.mockRestore())
    // A sift visits at most two children and one parent per level and writes two keyed records.
    // Overlay/base accesses and both writer passes are included in these measured update calls.
    const levels = 1 + Math.ceil(Math.log2(Math.max(2, count)))
    expect(indexOperations).toBeLessThanOrEqual(32 * updates * levels)
    // Includes reducer relations, setup/checkpoint/reopen, not just heap cursor reads.
    expect(structuralSql + structuralExec).toBeLessThanOrEqual(256 * (updates + tip) * levels)
    resumed.close()
    scratch.close()
    expect(failed).not.toHaveBeenCalled()
    expect(initialized).toHaveBeenCalledOnce()
    expect(facts()).toMatchObject({ known: true, openTurn: null })
    expect(mainRows).toBe(tip - cursor + 1)
    measurements.push({
      count,
      mapVisits,
      structuralVisits,
      mainRows,
      indexOperations,
      structuralSql,
      structuralExec,
      updates
    })
  }
  console.log('R3 linked scaling', measurements)
  expect(measurements[1].indexOperations).toBeLessThanOrEqual(20 * measurements[0].indexOperations)
  expect(measurements[1].structuralSql).toBeLessThanOrEqual(20 * measurements[0].structuralSql)
  expect.soft(measurements[1].mapVisits).toBeLessThanOrEqual(20 * measurements[0].mapVisits)
  expect
    .soft(measurements[1].structuralVisits)
    .toBeLessThanOrEqual(20 * measurements[0].structuralVisits)
})
