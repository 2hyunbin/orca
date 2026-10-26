import {
  clearedMailRecord as clearedRecord,
  mailTestResources
} from '../../runtime/orchestration/mail-handoff.test-fixture'
import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { encodeAgentSessionRecord } from '../../../shared/agent-session-record-stored-form'
import { OrchestrationDb } from '../../runtime/orchestration/db'
import { captureSessionMailAtStop } from '../../runtime/orchestration/session-mail-stop-inventory'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { JournalHostDatabase } from './journal-host-database'
import { JournalRowWriter, composeJournalOperationReceipts } from './journal-row-writer'
import { createJournalReducerState } from './journal-reducer'
import { journalStopEventRowBuilder } from './journal-stop-and-resume-rows'
import {
  mailAdmissionPermission,
  mailReleaseReceipt,
  mailStopReceipt,
  readMailHoldFacts
} from './journal-mail-holds'

const resources = mailTestResources('pr28567-mail-holds-')
function harness() {
  const root = resources.directory()
  const database = resources.track(JournalHostDatabase.open(root))
  const record = agentSessionRecordFixture({
    sessionId: testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
  })
  database.db
    .prepare('INSERT INTO agent_session_records VALUES (?, ?)')
    .run(record.sessionId, JSON.stringify(encodeAgentSessionRecord(record)))
  let sequence = 0
  const state = createJournalReducerState(record.sessionId, 'epoch')
  const writer = new JournalRowWriter({
    sessionId: record.sessionId,
    now: () => 100,
    serialize: async (run) => run(),
    database: () => database,
    readOnly: () => false,
    highestFence: () => 1,
    nextSequence: () => sequence + 1,
    commit: (rows) => {
      sequence = rows.at(-1)!.seq
    }
  })
  const facts = (db = database.db) => readMailHoldFacts(db, record.sessionId, () => [record], 0)
  const apply = (receipt: ReturnType<typeof mailReleaseReceipt>, target = database) => {
    target.transaction((db) => receipt.write(db))
    receipt.committed()
  }
  const stop = (
    capture: Parameters<typeof mailStopReceipt>[1] = () => ({}),
    extra = { write: () => {}, committed: () => {} }
  ) =>
    writer.append(
      journalStopEventRowBuilder(() => state, { reason: 'user-stop' }, 1),
      composeJournalOperationReceipts(mailStopReceipt(record.sessionId, capture), extra)
    )
  return { root, database, record, facts, apply, stop, writer, state }
}

it('persists exact unreserved obligations across restatement/reopen and repeated same-tuple Stops, releasing only on personal intent', async () => {
  const h = harness()
  expect(mailAdmissionPermission(h.facts(), ['fresh'])).toBe(false)
  h.apply(mailReleaseReceipt(h.record.sessionId))
  await h.stop()
  await h.stop(() => ({ members: ['A'] }))
  expect(mailAdmissionPermission(h.facts(), ['C'])).toBe(false)
  h.apply(mailReleaseReceipt(h.record.sessionId))
  await h.stop(() => ({ members: ['A', 'B'] }))
  expect(mailAdmissionPermission(h.facts(), ['A'])).toBe(false)
  expect(mailAdmissionPermission(h.facts(), ['C'])).toBe(true)
  await h.writer.append(journalStopEventRowBuilder(() => h.state, { reason: 'user-stop' }, 1))
  await h.writer.append(journalStopEventRowBuilder(() => h.state, { reason: 'host-stop' }, 1))
  expect([...h.facts().members]).toEqual(['A', 'B'])
  await h.stop(() => ({ members: ['C'] }))
  expect([...h.facts().members]).toEqual(['A', 'B', 'C'])
  h.database.close()
  const reopened = resources.track(JournalHostDatabase.open(h.root))
  expect(h.facts(reopened.db).members).toEqual(new Set(['A', 'B', 'C']))
  h.apply(mailReleaseReceipt(h.record.sessionId), reopened)
  expect(mailAdmissionPermission(h.facts(reopened.db), ['A', 'B'])).toBe(true)
})

it('rolls back Stop, hold and receipt together, cleaning up before any fold/publication even on failed COMMIT', async () => {
  const h = harness()
  h.apply(mailReleaseReceipt(h.record.sessionId))
  const mail = resources.track(new OrchestrationDb(join(h.root, 'mail.db')))
  const row = mail.insertMessage({
    from: 'worker',
    to: `orca_session_id:${h.record.sessionId}`,
    subject: 'owed'
  })
  const retire = vi.fn()
  const finished = vi.fn(() => {
    expect(h.database.db.isTransaction).toBe(false)
    expect(mail.db.isTransaction).toBe(false)
    expect(mail.db.pragma('busy_timeout', { simple: true })).toBe(5000)
  })
  const committed = vi.fn()
  const stop = () =>
    h.stop(
      (id, records, scope) => {
        const captured = captureSessionMailAtStop(mail, id, records, retire, scope)
        expect(captured.members).toEqual([row.id])
        return {
          ...captured,
          finished: () => {
            captured.finished?.()
            finished()
          }
        }
      },
      {
        write: () => {
          h.database.db.exec('PRAGMA defer_foreign_keys = ON')
          h.database.db.exec(
            'CREATE TABLE IF NOT EXISTS bad_fk (parent INTEGER REFERENCES agent_session_mail_holds(intent_order))'
          )
          h.database.db.prepare('INSERT INTO bad_fk VALUES (?)').run(9999)
        },
        committed
      }
    )
  await expect(stop()).rejects.toThrow()
  expect(finished).toHaveBeenCalledOnce()
  expect(committed).not.toHaveBeenCalled()
  expect(retire).not.toHaveBeenCalled()
  mail.db.exec('BEGIN IMMEDIATE; ROLLBACK')
  expect(h.facts()).toMatchObject({ ambiguous: false, members: new Set() })
  expect(h.database.db.prepare('SELECT count(*) AS n FROM journal_rows').get()?.n).toBe(0)
})

it.each([100, 1000])(
  'shares one linear lineage fold across %i aliases and preserves unrelated component permission tokens',
  (count) => {
    const h = harness()
    let visits = 0
    const records = Array.from({ length: count }, (_, index) => ({
      ...agentSessionRecordFixture({ sessionId: `lineage-${index}` }),
      get conversationCommand() {
        visits++
        return index + 1 < count
          ? clearedRecord(h.record, `lineage-${index + 1}`).conversationCommand
          : undefined
      }
    }))
    const all = [h.record, ...records]
    h.apply(mailReleaseReceipt(h.record.sessionId))
    h.apply(mailReleaseReceipt(records[0].sessionId))
    const read = vi.fn(() => all)
    const facts = readMailHoldFacts(h.database.db, records.at(-1)!.sessionId, read, 1)
    expect(facts.scope?.aliases).toHaveLength(count)
    expect(facts.scope?.root).toBe(records[0].sessionId)
    expect(visits).toBeLessThanOrEqual(4 * count)
    const unrelated = readMailHoldFacts(h.database.db, h.record.sessionId, read, 1)
    h.apply(mailReleaseReceipt(records[0].sessionId))
    expect(readMailHoldFacts(h.database.db, h.record.sessionId, read, 1)).toBe(unrelated)
    const changed = readMailHoldFacts(h.database.db, records[0].sessionId, read, 1)
    expect(changed.key).not.toBe(facts.key)
    expect(read).toHaveBeenCalledOnce()
    expect(readMailHoldFacts(h.database.db, h.record.sessionId, read, 2).key).toBe(unrelated.key)
    for (const record of records) {
      h.database.db
        .prepare('INSERT INTO agent_session_records VALUES (?, ?)')
        .run(record.sessionId, JSON.stringify(encodeAgentSessionRecord(record)))
    }
    const successor = records.at(-1)!.sessionId
    h.apply(mailStopReceipt(records[0].sessionId, () => ({ members: ['A'] })))
    h.apply(mailReleaseReceipt(successor))
    expect(
      mailAdmissionPermission(readMailHoldFacts(h.database.db, successor, read, 2), ['A'])
    ).toBe(true)
    h.apply(mailStopReceipt(successor, () => ({ members: ['C'] })))
    expect(readMailHoldFacts(h.database.db, successor, read, 2)).toMatchObject({
      members: new Set(['C']),
      ambiguous: false
    })
    const missing = clearedRecord(records[0], 'absent')
    expect(readMailHoldFacts(h.database.db, missing.sessionId, () => [missing], 3).ambiguous).toBe(
      true
    )
    const cycle = clearedRecord(missing, missing.sessionId)
    expect(readMailHoldFacts(h.database.db, cycle.sessionId, () => [cycle], 4).ambiguous).toBe(true)
  }
)
