import { expect } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import { structuredAgentSessionCommandTurnIdentity } from '../../../shared/structured-agent-session-command-turn-identity'
import { parseJournalRow } from './journal-row-schema'
import { buildJournalQueueRow } from './journal-queue-events'
import { readJournalRestFacts } from './journal-row-table'
import type { AgentSessionJournal } from './journal-store'
import type { JournalReducerState } from './journal-reducer'
import type { JournalHostDatabase } from './journal-host-database'
import type { populationWriter } from './journal-population-owner-test-support'

export async function exercisePopulationQueue(input: {
  current: AgentSessionJournal
  state: JournalReducerState
  writer: ReturnType<typeof populationWriter>
  database: JournalHostDatabase
  count: number
  text: AgentJournalMessageItem
  command: AgentJournalMessageItem
  publications: readonly { sequence: number; pair: unknown; rows: number }[]
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>
  queue: (
    id: string,
    attempt: string,
    position: number,
    body?: AgentJournalMessageItem
  ) => Promise<unknown>
  status: (id: string) => Promise<unknown>
}): Promise<void> {
  const {
    current,
    state,
    writer,
    database,
    count,
    text,
    command,
    publications,
    measure,
    queue,
    status
  } = input
  const sessionId = state.sessionId
  const reportIdentity = structuredAgentSessionCommandTurnIdentity('shared-report')
  const reportKey = agentJournalItemKey(reportIdentity)
  const reportBody = {
    kind: 'turn',
    turnId: 'shared-report',
    state: 'completed',
    outcome: 'failure'
  } as const
  const beforeReport = state.queue.revision
  await measure('final-presence', () =>
    current.appendLifecycleBatch({
      settlementId: 'absent-report-at-end',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          turnScope: AGENT_JOURNAL_THREAD_SCOPE,
          identity: reportIdentity,
          body: reportBody
        },
        { kind: 'tombstone', identity: reportIdentity }
      ]
    })
  )
  expect(state.items.has(reportKey)).toBe(false)
  expect(state.queue.revision).toBe(beforeReport)
  expect(state.queue.cards.get('group-card-0')?.state).toBe('returned')
  const beforePublication = publications.length
  await measure('queue-flush', () =>
    current.appendItem(reportIdentity, reportBody, {
      turnScope: AGENT_JOURNAL_THREAD_SCOPE,
      fence: 1
    })
  )
  expect(state.queue.revision).toBe(beforeReport + count)
  expect(
    Array.from({ length: count }, (_, index) => state.queue.cards.get(`group-card-${index}`)?.state)
  ).toEqual(Array(count).fill('withdrawn'))
  expect(state.queue.cards.get('other-card-0')?.state).toBe('returned')
  expect(publications).toHaveLength(beforePublication + 1)
  expect(publications.at(-1)?.sequence).toBe(current.cursor().sequence)
  expect(publications.at(-1)?.pair).toEqual(readJournalRestFacts(database.db, sessionId))
  await queue('report-before-card', 'shared-report', 3 * count)
  expect(state.queue.cards.get('report-before-card')?.state).toBe('returned')
  await status('later-original-trigger')
  expect(state.queue.cards.get('report-before-card')?.state).toBe('withdrawn')
  await queue('edit-into-command', 'shared-report', 3 * count + 1, text)
  await writer.enqueue((seq, ts) =>
    buildJournalQueueRow(
      state,
      'edit-into-command',
      {
        op: 'edited',
        body: command
      },
      seq,
      ts
    )
  )
  expect(state.queue.cards.get('edit-into-command')?.state).toBe('returned')
  await status('edited-card-trigger')
  expect(state.queue.cards.get('edit-into-command')?.state).toBe('withdrawn')
  const noReadySequence = current.cursor().sequence
  const noReadyQueue = state.queue.revision
  await writer.enqueue((seq, ts) => ({
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: state.epoch,
    seq,
    ts,
    fence: 1,
    kind: 'item',
    itemId: reportKey,
    revision: -1,
    body: reportBody
  }))
  expect(current.cursor().sequence).toBe(noReadySequence + 1)
  expect(state.queue.revision).toBe(noReadyQueue)
  await queue('ready-for-stale', 'shared-report', 3 * count + 2)
  expect(state.queue.cards.get('ready-for-stale')?.state).toBe('returned')
  const staleSequence = current.cursor().sequence
  const staleQueue = state.queue.revision
  const stalePublications = publications.length
  const unchangedReport = state.items.get(reportKey)
  await measure('stale-trigger', () =>
    writer.enqueue((seq, ts) => ({
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      epoch: state.epoch,
      seq,
      ts,
      fence: 1,
      kind: 'item',
      itemId: reportKey,
      revision: -1,
      body: reportBody
    }))
  )
  expect(current.cursor().sequence).toBe(staleSequence + 1)
  expect(state.items.get(reportKey)).toBe(unchangedReport)
  expect(state.queue.cards.get('ready-for-stale')?.state).toBe('withdrawn')
  expect(state.queue.revision).toBe(staleQueue + 1)
  expect(publications).toHaveLength(stalePublications + 1)

  const settlementSource = database.db
    .prepare(`SELECT row_json AS source FROM journal_rows
    WHERE session_id = ? AND json_extract(row_json,'$.settlementId') = ?`)
    .get(sessionId, 'absent-report-at-end')?.source
  if (typeof settlementSource !== 'string') {
    throw new Error('missing real nonempty settlement row')
  }
  const parsedSettlement = parseJournalRow(settlementSource)
  if (!parsedSettlement.ok || parsedSettlement.row.kind !== 'lifecycle-batch') {
    throw new Error('missing original parsed lifecycle settlement')
  }
  const originalSettlement = parsedSettlement.row
  expect(originalSettlement.mutations.length).toBeGreaterThan(0)
  expect(state.appliedSettlementIds.has(originalSettlement.settlementId)).toBe(true)
  await queue('ready-for-duplicate', 'shared-report', 3 * count + 3)
  const settledRevision = state.queue.revision
  const beforeNoOp = current.cursor()
  const noOpPublications = publications.length
  await current.appendLifecycleBatch({
    settlementId: originalSettlement.settlementId,
    fence: 1,
    mutations: []
  })
  expect(current.cursor()).toEqual(beforeNoOp)
  expect(state.queue.revision).toBe(settledRevision)
  expect(state.queue.cards.get('ready-for-duplicate')?.state).toBe('returned')
  expect(publications).toHaveLength(noOpPublications)
  await measure('duplicate-trigger', () =>
    writer.enqueue((seq, ts) => ({ ...originalSettlement, seq, ts }))
  )
  expect(current.cursor().sequence).toBe(beforeNoOp.sequence + 1)
  expect(state.items.get(reportKey)).toBe(unchangedReport)
  expect(state.queue.cards.get('ready-for-duplicate')?.state).toBe('withdrawn')
  expect(state.queue.revision).toBe(settledRevision + 1)
  expect(publications).toHaveLength(noOpPublications + 1)
}
