import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  assertScratchKeyEncoding,
  legacyEncodedRelations,
  assertOldScratchEncodingRebuild
} from './journal-scratch-encoding-test-support'
import { legacyRestScratchPath } from './journal-legacy-rest-scratch'
vi.mock('./journal-legacy-rest-worker', async () => {
  const { InProcessLegacyRestWorker } = await import('./journal-legacy-rest-replay-test-support')
  return { JournalLegacyRestWorker: InProcessLegacyRestWorker }
})

import {
  runJournalPopulationContract,
  type PopulationReceipt
} from './journal-population-flow-test-support'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { openAgentSessionJournal } from './journal-store-factory'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { readJournalRestFacts } from './journal-row-table'
import { JournalLegacyRestInitializer } from './journal-legacy-rest-initializer'
import {
  JournalStructuralScratch,
  type JournalStructuralCheckpoint
} from './journal-structural-scratch'
import { WorkBucket } from './journal-work-bucket'

let root: string
const sessionId = 'work-index-flow'
const identity = (id: string) =>
  ({ provider: 'codex', threadId: 'thread', turnId: id, ordinal: 0 }) as const
const open = () =>
  openAgentSessionJournal({
    identity: {
      sessionId,
      workspaceId: 'workspace',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread')
    },
    database: openTestJournalHostDatabase(root),
    now: () => 100
  })
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-work-index-flow-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

it.each([16, 160])(
  'bounds the actual %i-work context edge and rolls back a compound SQL failure',
  async (count) => {
    let journal = await open()
    for (let i = 0; i < count; i++) {
      await journal.appendSubmission({
        clientMessageId: `raw-${i}`,
        payloadFingerprint: `fp-${i}`,
        body: { kind: 'message', role: 'user', blocks: [] },
        fence: 1
      })
      await journal.appendItem(
        identity(`root-${i}`),
        {
          kind: 'turn',
          turnId: `root-${i}`,
          userItemId: `orca:raw-${i}`,
          startedAt: 100 + i,
          state: 'running'
        },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE, fence: 1 }
      )
    }
    const database = openTestJournalHostDatabase(root)
    const before = journal.snapshot()
    const head = journal.restFact()
    const pair = readJournalRestFacts(database.db, sessionId)
    const mutations = [0, 1].map((i) => ({
      kind: 'item' as const,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE,
      identity: identity(`root-${i}`),
      body: {
        kind: 'turn' as const,
        turnId: `root-${i}`,
        userItemId: `orca:raw-${i}`,
        startedAt: 100 + i,
        state: 'completed' as const,
        outcome: 'success' as const
      }
    }))
    database.db.exec(
      "CREATE TEMP TRIGGER fail_work_row BEFORE INSERT ON journal_rows BEGIN SELECT RAISE(ABORT, 'work SQL rollback'); END"
    )
    await expect(
      journal.appendLifecycleBatch({ settlementId: 'failed-compound', fence: 1, mutations })
    ).rejects.toThrow('work SQL rollback')
    expect(journal.snapshot()).toEqual(before)
    expect(journal.restFact()).toEqual(head)
    expect(readJournalRestFacts(database.db, sessionId)).toEqual(pair)
    database.db.exec('DROP TRIGGER fail_work_row')
    await journal.appendLifecycleBatch({ settlementId: 'retry-compound', fence: 1, mutations })
    expect(journal.restFact()).toEqual({
      itemId: agentJournalItemKey(identity('root-2')),
      since: 102
    })
    let updates = 0
    const original = WorkBucket.prototype.update
    const observed = vi.spyOn(WorkBucket.prototype, 'update').mockImplementation(function (
      this: WorkBucket,
      key,
      value
    ) {
      updates++
      return original.call(this, key, value)
    })
    let visits = 0
    const entries = Map.prototype.entries
    const scan = vi.spyOn(Map.prototype, 'entries').mockImplementation(function* (
      this: typeof Map.prototype
    ): ReturnType<typeof entries> {
      for (const value of entries.call(this)) {
        visits++
        yield value
      }
      return undefined
    })
    await journal.appendItem(
      identity('context'),
      {
        kind: 'status',
        text: 'Context cleared',
        contextClear: { operationId: 'clear-context', afterFence: 1, clearedAt: 200 }
      },
      {
        turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(identity(`root-${count - 1}`)) },
        fence: 1
      }
    )
    observed.mockRestore()
    scan.mockRestore()
    expect(updates).toBeLessThanOrEqual(8 * count)
    expect(visits).toBeLessThanOrEqual(24 * count)
    expect(journal.restFact()).toBeNull()
    expect(readJournalRestFacts(database.db, sessionId)?.openTurn).toBeNull()
    await journal.close()
    journal = await open()
    expect(journal.restFact()).toBeNull()
    expect(journal.snapshot().items.filter((item) => item.body.kind === 'turn')).toHaveLength(count)
    await journal.close()
  }
)

it('rolls back failed scratch relations and resumes the exact committed index/cursor', async () => {
  assertScratchKeyEncoding(root)
  const journal = await open()
  for (let i = 0; i < 80; i++) {
    await journal.appendItem(
      identity(`root-${i}`),
      { kind: 'turn', turnId: `root-${i}`, startedAt: 100 + i, state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE, fence: 1 }
    )
  }
  const expected = journal.restFact()
  const tip = journal.cursor().sequence
  await journal.close()
  const database = openTestJournalHostDatabase(root)
  database.db
    .prepare(
      'UPDATE journal_sessions SET open_turn_id = NULL, open_turn_since = NULL WHERE session_id = ?'
    )
    .run(sessionId)
  let scratch = new JournalStructuralScratch(legacyRestScratchPath(root, sessionId))
  const failed = vi.fn()
  const initialized = vi.fn()
  const make = () =>
    new JournalLegacyRestInitializer({
      database,
      candidates: () => [sessionId],
      owner: () => 'ended',
      initialized,
      failed
    })
  const prefix = make()
  await prefix.advance(() => {
    const checkpoint = scratch.load<JournalStructuralCheckpoint>()
    return (checkpoint?.cursor ?? 0) <= 1 || scratch.map('items').size === 0
  })
  await prefix.close()
  const saved = scratch.load<JournalStructuralCheckpoint>()!
  expect(saved.cursor).toBeGreaterThan(1)
  expect(saved.cursor).toBeLessThan(tip)
  expect(saved.selection?.format).toBe(7)
  const legacyRelations = legacyEncodedRelations(scratch)
  const relations = Array.from(scratch.map('work:active:slots'))
  const save = JournalStructuralScratch.prototype.save
  const failure = vi
    .spyOn(JournalStructuralScratch.prototype, 'save')
    .mockImplementationOnce(function (this: JournalStructuralScratch, value) {
      save.call(this, value)
      throw new Error('failed between relation updates and checkpoint COMMIT')
    })
  const interrupted = make()
  await interrupted.advance(() => true)
  await interrupted.close()
  failure.mockRestore()
  expect(failed).toHaveBeenCalledOnce()
  expect(initialized).not.toHaveBeenCalled()
  scratch.close()
  scratch = new JournalStructuralScratch(legacyRestScratchPath(root, sessionId))
  expect(scratch.load()).toEqual(saved)
  expect(Array.from(scratch.map('work:active:slots'))).toEqual(relations)
  const cursors: number[] = []
  const prepare = database.db.prepare.bind(database.db)
  const statements = new WeakSet<object>()
  const main = vi.spyOn(database.db, 'prepare').mockImplementation((query) => {
    const statement = prepare(query)
    if (query.includes('ORDER BY seq ASC LIMIT') && !statements.has(statement)) {
      statements.add(statement)
      const all = statement.all.bind(statement)
      vi.spyOn(statement, 'all').mockImplementation((...args) => {
        cursors.push(Number(args[2]))
        return all(...args)
      })
    }
    return statement
  })
  const resumed = make()
  await resumed.advance(() => true)
  await resumed.close()
  expect(new Set(cursors).size).toBe(tip - saved.cursor + 1)
  expect(cursors[0]).toBe(saved.cursor)
  expect(cursors.every((cursor) => cursor >= saved.cursor)).toBe(true)
  expect(initialized).toHaveBeenCalledOnce()
  expect(readJournalRestFacts(database.db, sessionId)?.openTurn).toEqual(expected)
  database.db
    .prepare(
      'UPDATE journal_sessions SET open_turn_id = NULL, open_turn_since = NULL WHERE session_id = ?'
    )
    .run(sessionId)
  scratch.save({
    ...saved,
    guard: JSON.stringify([3, ...JSON.parse(saved.guard).slice(1)]),
    rest: { ...saved.rest, active: saved.rest.active.head }
  })
  const readsBeforeUpgrade = cursors.length
  const oldFormat = make()
  await oldFormat.advance(() => true)
  await oldFormat.close()
  expect(new Set(cursors.slice(readsBeforeUpgrade)).size).toBe(tip + 1)
  expect(cursors[readsBeforeUpgrade]).toBe(0)
  expect(initialized).toHaveBeenCalledTimes(2)
  expect(readJournalRestFacts(database.db, sessionId)?.openTurn).toEqual(expected)
  await assertOldScratchEncodingRebuild(database, scratch, saved, legacyRelations, make, cursors)
  expect(initialized).toHaveBeenCalledTimes(3)
  expect(failed).toHaveBeenCalledOnce()
  expect(readJournalRestFacts(database.db, sessionId)?.openTurn).toEqual(expected)
  main.mockRestore()
  scratch.close()
})

it('bounds the complete writer, COW and resumable SQLite fold at N and 10N', async () => {
  const receipts: PopulationReceipt[] = []
  for (const count of [16, 160]) {
    receipts.push(await runJournalPopulationContract(join(root, `population-${count}`), count))
  }
  const [small, large] = receipts
  for (const name of [
    'construction',
    'unrelated-series',
    'context-and-echo',
    'queue-flush',
    'request-seed',
    'request-descending',
    'clear-seed',
    'clear-nonmaximum',
    'shared-legacy-series',
    'shared-legacy-relevant',
    'structural-resume-cleanup'
  ]) {
    expect(large.phases[name].points).toBeLessThanOrEqual(24 * small.phases[name].points)
    expect(large.phases[name].sqlCalls).toBeLessThanOrEqual(24 * small.phases[name].sqlCalls + 128)
  }
  for (const name of [
    'construction',
    'unrelated-series',
    'context-and-echo',
    'request-descending',
    'clear-nonmaximum',
    'shared-legacy-series'
  ]) {
    const smallVisits =
      small.phases[name].iteratorSteps - small.phases[name].settlementIteratorSteps
    const largeVisits =
      large.phases[name].iteratorSteps - large.phases[name].settlementIteratorSteps
    expect(largeVisits).toBeLessThanOrEqual(24 * smallVisits + 128)
  }
  expect(large.phases.unrelated.iteratorSteps).toBeLessThanOrEqual(
    small.phases.unrelated.iteratorSteps + 4096
  )
  console.info('journal population operation receipts', JSON.stringify(receipts))
})
