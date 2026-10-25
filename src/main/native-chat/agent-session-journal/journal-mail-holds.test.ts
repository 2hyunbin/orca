import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { foundAgentSessionRecord } from '../../runtime/agent-session-record-founding'
import { encodeAgentSessionRecord } from '../../../shared/agent-session-record-stored-form'
import { JournalHostDatabase } from './journal-host-database'
import { JournalRowWriter, composeJournalOperationReceipts } from './journal-row-writer'
import { createJournalReducerState } from './journal-reducer'
import { journalStopEventRowBuilder } from './journal-stop-and-resume-rows'
import {
  mailAdmissionPermission,
  mailHoldsCommitted,
  mailReleaseReceipt,
  mailStopReceipt,
  readMailHoldFacts,
  writeMailHold
} from './journal-mail-holds'

const roots: string[] = []
const databases: JournalHostDatabase[] = []
afterEach(() => {
  databases.splice(0).forEach((db) => db.close())
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'pr28567-mail-holds-'))
  roots.push(root)
  const database = JournalHostDatabase.open(root)
  databases.push(database)
  const record = foundAgentSessionRecord(
    {
      sessionId: 'recipient',
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/tmp/unused' },
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'folder',
        workspaceKind: 'folder'
      }
    },
    { claimKeyId: 'key', now: 100 }
  )
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
  const facts = () => readMailHoldFacts(database.db, record.sessionId, () => [record], 0)
  const apply = (receipt: ReturnType<typeof mailReleaseReceipt>) => {
    database.transaction((db) => receipt.write(db))
    receipt.committed()
  }
  const stop = (ids?: string[], extra = { write: () => {}, committed: () => {} }) =>
    writer.append(
      journalStopEventRowBuilder(() => state, { reason: 'user-stop' }, 1),
      composeJournalOperationReceipts(
        mailStopReceipt(record.sessionId, () => ({ members: ids })),
        extra
      )
    )
  return { root, database, record, facts, apply, stop, writer, state }
}

it('persists exact unreserved obligations across restatement/reopen and repeated same-tuple Stops, releasing only on personal intent', async () => {
  const h = harness()
  expect(mailAdmissionPermission(h.facts(), ['fresh'])).toBe(false)
  h.apply(mailReleaseReceipt(h.record.sessionId))
  await h.stop(['A', 'B'])
  expect(mailAdmissionPermission(h.facts(), ['A'])).toBe(false)
  expect(mailAdmissionPermission(h.facts(), ['C'])).toBe(true)
  await h.writer.append(journalStopEventRowBuilder(() => h.state, { reason: 'user-stop' }, 1))
  await h.writer.append(journalStopEventRowBuilder(() => h.state, { reason: 'host-stop' }, 1))
  expect([...h.facts().members]).toEqual(['A', 'B'])
  await h.stop(['C'])
  expect([...h.facts().members]).toEqual(['A', 'B', 'C'])
  h.database.close()
  const reopened = JournalHostDatabase.open(h.root)
  databases.push(reopened)
  expect(readMailHoldFacts(reopened.db, h.record.sessionId, () => [h.record], 0).members).toEqual(
    new Set(['A', 'B', 'C'])
  )
  const release = mailReleaseReceipt(h.record.sessionId)
  reopened.transaction((db) => release.write(db))
  release.committed()
  expect(
    mailAdmissionPermission(
      readMailHoldFacts(reopened.db, h.record.sessionId, () => [h.record], 0),
      ['A', 'B']
    )
  ).toBe(true)
})

it('rolls back Stop, hold and receipt together, cleaning up before any fold/publication even on failed COMMIT', async () => {
  const h = harness()
  h.apply(mailReleaseReceipt(h.record.sessionId))
  const finished = vi.fn(() => expect(h.database.db.isTransaction).toBe(false))
  const committed = vi.fn()
  const stop = () =>
    h.writer.append(
      journalStopEventRowBuilder(() => h.state, { reason: 'user-stop' }, 1),
      composeJournalOperationReceipts(
        mailStopReceipt(h.record.sessionId, () => ({ members: ['A'], finished })),
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
    )
  await expect(stop()).rejects.toThrow()
  expect(finished).toHaveBeenCalledOnce()
  expect(committed).not.toHaveBeenCalled()
  expect(h.facts()).toMatchObject({ ambiguous: false, members: new Set() })
  expect(h.database.db.prepare('SELECT count(*) AS n FROM journal_rows').get()?.n).toBe(0)
})

it('carries UNKNOWN through a later exact capture until a witnessed release and preserves alias release floors', async () => {
  const h = harness()
  h.apply(mailReleaseReceipt(h.record.sessionId))
  await h.stop()
  await h.stop(['A'])
  expect(mailAdmissionPermission(h.facts(), ['C'])).toBe(false)
  const successor = { ...h.record, sessionId: 'successor' }
  const predecessor = {
    ...h.record,
    conversationCommand: {
      command: 'clear',
      state: 'completed',
      phase: 'committed',
      operationId: 'clear',
      callerKey: 'person',
      replacementSessionId: successor.sessionId
    } as const
  }
  const aliases = () => [predecessor, successor]
  h.apply(mailReleaseReceipt(successor.sessionId))
  const released = readMailHoldFacts(h.database.db, successor.sessionId, aliases, 1)
  expect(mailAdmissionPermission(released, ['A'])).toBe(true)
  const releaseOrder = Number(
    h.database.db
      .prepare('SELECT intent_order FROM agent_session_mail_holds WHERE session_id = ?')
      .get(successor.sessionId)?.intent_order
  )
  h.database.transaction((db) =>
    writeMailHold(db, successor.sessionId, {
      version: 1,
      status: 'held',
      members: ['C'],
      ambiguous: false,
      releasedThrough: releaseOrder
    })
  )
  mailHoldsCommitted(h.database.db)
  const later = readMailHoldFacts(h.database.db, successor.sessionId, aliases, 2)
  expect([...later.members]).toEqual(['C'])
  expect(later.ambiguous).toBe(false)
})
