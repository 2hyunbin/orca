import { serialize } from 'node:v8'
import { expect, vi } from 'vitest'
import {
  agentJournalSubmissionKey,
  boundJournalKeyComponent
} from '../../../shared/agent-session-journal-item-key'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from './journal-store'
import type { JournalRow } from './journal-row-schema'
import { openTestJournalHostDatabase } from './journal-host-database-test-support'
import { populationState, populationWriter } from './journal-population-owner-test-support'
import { readJournalRestFacts } from './journal-row-table'

const turnIdentity = (id: string) =>
  ({ provider: 'codex', threadId: 'population-thread', turnId: id, ordinal: 0 }) as const

export async function exercisePopulationRetirement(
  current: AgentSessionJournal,
  root: string,
  submission: (raw: string, at: number) => Promise<unknown>,
  publications: readonly unknown[],
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>
): Promise<string> {
  const state = populationState(current)
  const writer = populationWriter(current)
  const database = openTestJournalHostDatabase(root)
  const sessionId = state.sessionId
  const raw = `\0\ud800\n${'R'.repeat(1200)}`
  const diagnostic = boundJournalKeyComponent(raw)
  expect(agentJournalSubmissionKey(raw)).not.toBe(agentJournalSubmissionKey(diagnostic))
  for (const id of [raw, diagnostic, '\ud800', '%FFliteral']) {
    await submission(id, 700)
    await current.resolveDispatch({
      clientMessageId: id,
      fence: 1,
      state: 'accepted',
      providerIdentity: turnIdentity(`receipt-${id}`)
    })
  }
  await submission(raw, 700)
  await current.resolveDispatch({
    clientMessageId: raw,
    fence: 1,
    state: 'accepted',
    providerIdentity: turnIdentity('second-raw-alias')
  })
  expect(state.selection.groups.has(`aliases:${agentJournalSubmissionKey(raw)}`)).toBe(true)
  const rawKey = agentJournalSubmissionKey(raw)
  const retirement = (seq: number, ts: number): JournalRow => ({
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: state.epoch,
    seq,
    ts,
    fence: 1,
    kind: 'tombstone',
    itemId: rawKey,
    revision: 100,
    retireSubmission: true
  })
  const rowCountBefore = Number(
    database.db
      .prepare('SELECT COUNT(*) AS n FROM journal_rows WHERE session_id = ?')
      .get(sessionId)?.n
  )
  const before = serialize({
    snapshot: current.snapshot(),
    fact: current.restFact(),
    pair: readJournalRestFacts(database.db, sessionId),
    aliases: [...state.aliases],
    sources: Array.from(state.selection.storage.map('submissionSources')),
    roots: Array.from(state.selection.storage.map('treeRoots')),
    receipts: [...state.receipts],
    groups: Array.from(state.selection.storage.map('groupMembers')),
    counters: Array.from(state.selection.storage.map('counters'))
  })
  const publishedBeforeFailure = publications.length
  database.db.exec(`CREATE TEMP TRIGGER fail_population_pair BEFORE UPDATE OF open_turn_id
    ON journal_sessions BEGIN SELECT RAISE(ABORT, 'population pair failure'); END`)
  // Force a changed pair so the injected failure is reached after preparation and row insertion.
  state.persistedRest = ['uncommitted-mismatch', -1]
  await expect(writer.enqueue(retirement)).rejects.toThrow('population pair failure')
  database.db.exec('DROP TRIGGER fail_population_pair')
  const after = serialize({
    snapshot: current.snapshot(),
    fact: current.restFact(),
    pair: readJournalRestFacts(database.db, sessionId),
    aliases: [...state.aliases],
    sources: Array.from(state.selection.storage.map('submissionSources')),
    roots: Array.from(state.selection.storage.map('treeRoots')),
    receipts: [...state.receipts],
    groups: Array.from(state.selection.storage.map('groupMembers')),
    counters: Array.from(state.selection.storage.map('counters'))
  })
  expect(after).toEqual(before)
  expect(publications).toHaveLength(publishedBeforeFailure)
  expect(
    database.db
      .prepare('SELECT COUNT(*) AS n FROM journal_rows WHERE session_id = ?')
      .get(sessionId)?.n
  ).toBe(rowCountBefore)
  await expect(
    writer.enqueue(retirement, {
      write: () => {
        throw new Error('population receipt failure')
      },
      committed: vi.fn()
    })
  ).rejects.toThrow('population receipt failure')
  expect(publications).toHaveLength(publishedBeforeFailure)
  expect(
    database.db
      .prepare('SELECT COUNT(*) AS n FROM journal_rows WHERE session_id = ?')
      .get(sessionId)?.n
  ).toBe(rowCountBefore)
  expect(
    serialize({
      snapshot: current.snapshot(),
      fact: current.restFact(),
      pair: readJournalRestFacts(database.db, sessionId),
      aliases: [...state.aliases],
      sources: Array.from(state.selection.storage.map('submissionSources')),
      roots: Array.from(state.selection.storage.map('treeRoots')),
      receipts: [...state.receipts],
      groups: Array.from(state.selection.storage.map('groupMembers')),
      counters: Array.from(state.selection.storage.map('counters'))
    })
  ).toEqual(before)
  expect(current.receiptFor(raw)).not.toBeNull()
  expect(state.selection.rawAt(agentJournalSubmissionKey('negative-raw'))).toBeUndefined()
  expect(current.submission(diagnostic)?.clientMessageId).toBe(diagnostic)
  await measure('retirement', () => writer.enqueue(retirement))
  expect(current.submission(raw)).toBeUndefined()
  expect(current.receiptFor(raw)).toBeNull()
  expect(current.submission(diagnostic)?.clientMessageId).toBe(diagnostic)
  expect(current.receiptFor(diagnostic)?.clientMessageId).toBe(diagnostic)
  expect([...state.aliases.values()]).not.toContain(rawKey)
  expect(state.selection.rawAt(rawKey)).toBeUndefined()
  await submission(raw, 700)
  expect(state.selection.rawAt(rawKey)).toBe(raw)

  return raw
}
