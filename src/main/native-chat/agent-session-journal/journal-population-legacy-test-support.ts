import { DISPATCH_REJECTED_HOST_RESTARTED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { expect } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import {
  agentSessionJournalProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'
import { JournalWriteQueue } from './journal-write-queue'
import type { AgentSessionJournal } from './journal-store'
import { openTestJournalHostDatabase } from './journal-host-database-test-support'
import { populationState, populationWriter } from './journal-population-owner-test-support'

const text: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'shared accepted input' }]
}
const turnIdentity = (id: string) =>
  ({ provider: 'codex', threadId: 'population-thread', turnId: id, ordinal: 0 }) as const

export async function runLegacyPopulation(
  journal: AgentSessionJournal,
  root: string,
  count: number,
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>,
  status: (id: string) => Promise<unknown>
): Promise<void> {
  const database = openTestJournalHostDatabase(root)
  const state = populationState(journal)
  const writer = populationWriter(journal)
  const insert = database.db.prepare(`INSERT INTO queued_messages
    (session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state,
     hold_reason,returned_reason,returned_rejection,settled_at,settled_by_op,consumed_as,
     carried_from,queued_epoch,queued_sequence,options_json)
    VALUES(?,?,?,?,?,100,'population','waiting',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`)
  const fp = agentSessionSendBodyFingerprint(state.sessionId, text)
  for (let index = 0; index < count; index++) {
    insert.run(state.sessionId, `legacy-${index}`, 30 * count + index, JSON.stringify(text), fp)
    for (const [suffix, rejection] of [
      ['old', true],
      ['latest', false]
    ] as const) {
      await writer.enqueue((seq, ts) => ({
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: state.epoch,
        seq,
        ts,
        fence: 1,
        kind: 'submission',
        clientMessageId: `legacy-attempt-${index}-${suffix}`,
        queuedMessageId: `legacy-${index}`,
        body: text,
        payloadFingerprint: fp,
        providerHandle: agentSessionJournalProviderHandle({
          agent: 'codex',
          providerHandle: codexProviderHandle('population-thread')
        }),
        handoverRecorded: true
      }))
      if (rejection) {
        await journal.resolveDispatch({
          clientMessageId: `legacy-attempt-${index}-${suffix}`,
          fence: 1,
          state: 'pending',
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
        await writer.enqueue((seq, ts) => ({
          v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
          epoch: state.epoch,
          seq,
          ts,
          fence: 1,
          kind: 'dispatch',
          clientMessageId: `legacy-attempt-${index}-${suffix}`,
          state: 'rejected',
          reason: DISPATCH_REJECTED_HOST_RESTARTED,
          providerItemId: null
        }))
      }
    }
  }
  // Use the real import/read owner on these durable rows, with the actual current write lane.
  const { LegacyQueuedCards } = await import('./journal-queue-import')
  let readOnly = true
  const legacy = new LegacyQueuedCards({
    sessionId: state.sessionId,
    database: () => database,
    state: () => state,
    serialize: (run) => {
      const owner: unknown = journal
      const lane =
        typeof owner === 'object' && owner !== null && 'queue' in owner ? owner.queue : undefined
      if (!(lane instanceof JournalWriteQueue)) {
        throw new Error('missing real journal lane')
      }
      return lane.serialize(run)
    },
    readOnly: () => readOnly,
    writer,
    committed: () => {}
  })
  await legacy.importAtOpen()
  expect(
    database.db
      .prepare('SELECT COUNT(*) AS n FROM queued_messages WHERE session_id = ?')
      .get(state.sessionId)?.n
  ).toBe(count)
  expect(legacy.get('legacy-0')?.holdReason).toBe('delivery_unconfirmed')
  expect(legacy.displayState().submissions.get('legacy-attempt-0-old')?.dispatchState).toBe(
    'rejected'
  )
  readOnly = false
  database.db.exec(`CREATE TEMP TRIGGER fail_population_import BEFORE INSERT ON journal_rows
    WHEN json_extract(NEW.row_json,'$.kind') = 'queue'
    BEGIN SELECT RAISE(ABORT, 'population import rollback'); END`)
  await measure('legacy-failed-import', () => legacy.importAtOpen())
  database.db.exec('DROP TRIGGER fail_population_import')
  expect(
    database.db
      .prepare('SELECT COUNT(*) AS n FROM queued_messages WHERE session_id = ?')
      .get(state.sessionId)?.n
  ).toBe(count)
  expect(legacy.cards()).toHaveLength(count)
  expect(legacy.get('legacy-0')?.holdReason).toBe('delivery_unconfirmed')
  const key = legacy.key()
  const normalized = legacy.normalizationKey()
  const beforeSequence = legacy.displayState().lastSequence
  await measure('legacy-irrelevant', async () => {
    await status('legacy-unrelated-display')
    const displayed = legacy.displayState()
    expect(displayed.lastSequence).toBe(state.lastSequence)
    expect(displayed.items.has(agentJournalItemKey(turnIdentity('legacy-unrelated-display')))).toBe(
      true
    )
    expect(legacy.key()).toBe(key)
    expect(legacy.normalizationKey()).toBe(normalized)
  })
  expect(beforeSequence).toBeLessThan(state.lastSequence)
  await journal.resolveDispatch({
    clientMessageId: 'legacy-attempt-0-latest',
    fence: 1,
    state: 'pending',
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  await writer.enqueue((seq, ts) => ({
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: state.epoch,
    seq,
    ts,
    fence: 1,
    kind: 'dispatch',
    clientMessageId: 'legacy-attempt-0-latest',
    state: 'rejected',
    reason: DISPATCH_REJECTED_HOST_RESTARTED,
    providerItemId: null
  }))
  expect(legacy.get('legacy-0')?.consumedAs).toBe('legacy-attempt-0-latest')
  const display = legacy.displayState()
  expect(display.submissions.get('legacy-attempt-0-latest')?.dispatchState).toBe('unknown')
  const normalizationRows = [...display.normalizedHandOffs].sort().flatMap((id) => {
    const item = display.items.get(agentJournalSubmissionKey(id))
    const submission = display.submissions.get(id)
    return item && submission
      ? [[id, item.sequence, item.observedAt, item.turnScope, submission.queuedMessageId ?? null]]
      : []
  })
  expect(legacy.normalizationKey()).toBe(
    normalizationRows.length ? JSON.stringify([state.epoch, normalizationRows]) : ''
  )
  expect(state.submissions.get('legacy-attempt-0-latest')?.dispatchState).toBe('rejected')
  const maximum = 31 * count - 1
  expect(legacy.maximumPosition()).toBe(maximum)
  await writer.enqueue(
    (seq, ts) => ({
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      epoch: state.epoch,
      seq,
      ts,
      fence: 1,
      kind: 'item',
      itemId: agentJournalItemKey(turnIdentity('legacy-deletion')),
      revision: 0,
      body: { kind: 'status', text: 'legacy deletion receipt' }
    }),
    legacy.deletion([`legacy-${count - 1}`])
  )
  expect(legacy.maximumPosition()).toBe(maximum - 1)
  await measure('legacy-import-retry', () => legacy.importAtOpen())
  expect(
    database.db
      .prepare('SELECT COUNT(*) AS n FROM queued_messages WHERE session_id = ?')
      .get(state.sessionId)?.n
  ).toBe(0)
  expect(legacy.cards()).toEqual([])
}
