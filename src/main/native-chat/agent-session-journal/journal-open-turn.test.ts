// The chat's open root turn, saved beside its epoch pointer: what the next launch reads instead of
// the chat's history to say whether a turn was cut when its host stopped.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalTurnItem
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { journalPragmaNumber, openJournalDatabase } from './journal-database'
import {
  createAgentSessionRecordTablesSql,
  createJournalTablesSql,
  JOURNAL_DB_SCHEMA_VERSION
} from './journal-database-schema'
import { journalDatabasePath } from './journal-host-database'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { readJournalRestFacts } from './journal-row-table'
import { agentSessionCurrentContextRows } from '../../../shared/agent-session-context-clear'
import { latestStructuredAgentSessionRequest } from '../../../shared/structured-agent-session-latest-request'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { applyJournalRow, createJournalReducerState, renderJournalState } from './journal-reducer'
import { stageJournalMutation } from './journal-mutation-stage'
import type { JournalRow } from './journal-row-schema'
import { openAgentSessionJournal } from './journal-store-factory'

const SESSION = 'session-1'
const STARTED_AT = 1_800_000_000_000

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-open-turn-'))
})

afterEach(async () => {
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

const turnIdentity = (turnId: string): AgentJournalItemIdentity => ({
  provider: 'codex',
  threadId: 'thread-1',
  turnId,
  ordinal: 0
})

function turn(
  turnId: string,
  state: AgentJournalTurnItem['state'],
  outcome?: AgentJournalTurnItem['outcome']
): AgentJournalTurnItem {
  return { kind: 'turn', turnId, state, startedAt: STARTED_AT, ...(outcome ? { outcome } : {}) }
}

async function openJournal() {
  return openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    database: openTestJournalHostDatabase(root),
    now: () => STARTED_AT
  })
}

const openTurn = () => readJournalRestFacts(openTestJournalHostDatabase(root).db, SESSION)?.openTurn

it('brings a version 4 database forward, with every chat it held at rest', () => {
  const path = journalDatabasePath(root)
  const seeded = new Database(path)
  seeded.exec(createJournalTablesSql())
  seeded.exec(createAgentSessionRecordTablesSql())
  seeded
    .prepare('INSERT INTO journal_sessions (session_id, workspace_id, epoch) VALUES (?, ?, ?)')
    .run(SESSION, 'workspace-1', 'epoch-1')
  seeded.pragma('user_version = 4')
  seeded.close()

  const { db } = openJournalDatabase(path)
  try {
    expect(journalPragmaNumber(db, 'user_version')).toBe(JOURNAL_DB_SCHEMA_VERSION)
    expect(readJournalRestFacts(db, SESSION)).toEqual({
      openTurn: null,
      lastSequence: 0,
      lastSavedAt: 0
    })
  } finally {
    db.close()
  }
})

it('opens with the row that starts a turn, stays open through a cut, and closes on a finish', async () => {
  const journal = await openJournal()
  const write = (body: AgentJournalTurnItem) =>
    journal.appendItem(turnIdentity(body.turnId), body, {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  const cut = { itemId: agentJournalItemKey(turnIdentity('turn-1')), since: STARTED_AT }

  await write(turn('turn-1', 'running'))
  expect(openTurn()).toEqual(cut)
  // A quit, a crash or a Stop ends the turn without a finish: the next launch reads it cut.
  await write(turn('turn-1', 'interrupted'))
  expect(openTurn()).toEqual(cut)

  await write(turn('turn-2', 'running'))
  await write(turn('turn-2', 'completed', 'failure'))
  expect(openTurn()).toBeNull()
  await journal.close()
})

it('keeps rows, canonical state and the rest fact unchanged on transaction failure, then retries', async () => {
  const journal = await openJournal()
  const database = openTestJournalHostDatabase(root)
  const previous = journal.snapshot()
  const transaction = database.transaction.bind(database)
  const failed = vi.spyOn(database, 'transaction').mockImplementationOnce((run) =>
    transaction((db) => {
      run(db)
      expect(openTurn()).not.toBeNull()
      throw new Error('commit failed')
    })
  )
  await expect(
    journal.appendItem(turnIdentity('turn-1'), turn('turn-1', 'running'), { fence: 1 })
  ).rejects.toThrow('commit failed')
  expect(journal.snapshot()).toEqual(previous)
  expect(openTurn()).toBeNull()
  failed.mockRestore()
  await journal.appendItem(turnIdentity('turn-1'), turn('turn-1', 'running'), { fence: 1 })
  await journal.close()
  const reopened = await openJournal()
  expect(reopened.restFact()).toEqual(openTurn())
  expect(openTurn()?.itemId).toBe(agentJournalItemKey(turnIdentity('turn-1')))
  await reopened.close()
})

it('agrees with the canonical current-context request through retained-history mutations and reopen', async () => {
  let journal = await openJournal()
  const assertFact = () => {
    const snapshot = journal.snapshot()
    const current = agentSessionCurrentContextRows(snapshot.items, snapshot.submissions)
    const request = latestStructuredAgentSessionRequest(current.items, current.submissions)
    const cut =
      request?.kind === 'turn' &&
      (request.turnState !== 'completed' || request.outcome === 'cancellation')
    const item = current.items.find(
      (item) => readAgentJournalTurn(item.body)?.turnId === request?.id
    )
    expect(openTurn()).toEqual(cut && item ? { itemId: item.itemId, since: STARTED_AT } : null)
    expect(journal.restFact()).toEqual(openTurn())
  }
  const write = async (
    id: string,
    state: AgentJournalTurnItem['state'],
    outcome?: AgentJournalTurnItem['outcome']
  ) => {
    await journal.appendItem(turnIdentity(id), turn(id, state, outcome), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    assertFact()
  }
  await write('t1', 'interrupted', 'cancellation')
  const retained = journal.snapshot().items.map((item) => ({
    identity: parseAgentJournalItemKey(item.itemId)!,
    body: item.body,
    observedAt: item.observedAt,
    turnScope: item.turnScope,
    ownerFence: 1
  }))
  await journal.replaceEpochItems('unreconcilable_prefix', 1, retained)
  assertFact()
  await write('t2', 'completed', 'success')
  await write('t1', 'interrupted', 'cancellation')
  await journal.appendTombstone(turnIdentity('t2'), { fence: 1 })
  assertFact()
  await journal.context.clear(
    { operationId: 'clear-1', afterFence: 1, clearedAt: STARTED_AT },
    { write: () => {}, committed: () => {} },
    'clear-op'
  )
  assertFact()
  const floor = journal.context.floor()!
  await write('t3', 'completed', 'success')
  await write('t4', 'interrupted', 'cancellation')
  await journal.context.rewind(
    floor,
    1,
    [{ identity: turnIdentity('t3'), body: turn('t3', 'completed', 'success'), ownerFence: 1 }],
    () => ({ write: () => {}, committed: () => {} })
  )
  assertFact()
  await journal.close()
  journal = await openJournal()
  assertFact()
  await journal.close()
})

it('stages canonical command, revision and inherited-producer semantics without changing published state', () => {
  const state = createJournalReducerState(SESSION, 'epoch')
  let seq = 0
  const apply = (
    fields: Omit<Extract<JournalRow, { kind: 'item' }>, 'v' | 'epoch' | 'seq' | 'ts' | 'fence'>
  ) => {
    const row: JournalRow = {
      v: 1,
      epoch: 'epoch',
      seq: ++seq,
      ts: STARTED_AT,
      fence: 1,
      ...fields
    }
    const prior = renderJournalState(state)
    const staged = stageJournalMutation(state, [row])
    expect(renderJournalState(state)).toEqual(prior)
    applyJournalRow(state, row)
    expect(staged.rest.fact()).toEqual(state.rest.fact())
    const snapshot = renderJournalState(state)
    const context = agentSessionCurrentContextRows(snapshot.items, snapshot.submissions)
    const request = latestStructuredAgentSessionRequest(context.items, context.submissions)
    expect(state.rest.fact()?.itemId ?? null).toBe(
      request?.turnState === 'interrupted' ? request.id : null
    )
  }
  apply({ kind: 'item', itemId: 't1', revision: 2, body: turn('t1', 'interrupted') })
  apply({
    kind: 'item',
    itemId: 'cmd',
    revision: 1,
    body: { kind: 'message', role: 'user', blocks: [], command: { name: 'compact' } }
  })
  apply({
    kind: 'item',
    itemId: 'tc',
    revision: 1,
    body: { ...turn('tc', 'completed'), userItemId: 'cmd' }
  })
  apply({
    kind: 'item',
    itemId: 'sub',
    revision: 1,
    agentId: 'child',
    body: turn('sub', 'completed')
  })
  apply({ kind: 'item', itemId: 'sub', revision: 2, body: turn('sub', 'interrupted') })
  apply({ kind: 'item', itemId: 't1', revision: 1, body: turn('t1', 'completed') })
})

it('does no transcript iteration for streamed output or ordinary turn edges at N and 10N', async () => {
  const measure = async (count: number) => {
    const journal = await openJournal()
    for (let i = 0; i < count; i++) {
      await journal.appendItem(turnIdentity(`history-${i}`), turn(`history-${i}`, 'completed'), {
        fence: 1
      })
    }
    const original = Map.prototype[Symbol.iterator]
    const values = Map.prototype.values
    let visits = 0
    const entries = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function* () {
      for (const entry of original.call(this)) {
        visits++
        yield entry
      }
    })
    const observedValues = vi.spyOn(Map.prototype, 'values').mockImplementation(function* () {
      for (const value of values.call(this)) {
        visits++
        yield value
      }
    })
    try {
      await journal.appendItem(turnIdentity('live'), turn('live', 'running'), { fence: 1 })
      const assistant = {
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'live',
        ordinal: 1
      } as const
      for (let i = 0; i < 8; i++) {
        await journal.appendItem(
          assistant,
          { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `${i}` }] },
          { fence: 1 }
        )
      }
      await journal.appendItem(turnIdentity('live'), turn('live', 'completed'), { fence: 1 })
      return visits
    } finally {
      entries.mockRestore()
      observedValues.mockRestore()
      await journal.close()
    }
  }
  expect(await measure(200)).toBe(await measure(20))
})

it('accepts known-id echoes without scanning/copying unrelated submissions; retains digest fallback', () => {
  for (const count of [20, 200]) {
    const state = createJournalReducerState(SESSION, 'e')
    const base = { v: 1, epoch: 'e', fence: 1, ts: STARTED_AT } as const
    for (let index = 0; index < count; index++) {
      applyJournalRow(state, {
        ...base,
        seq: index + 1,
        kind: 'submission',
        clientMessageId: `send-${index}`,
        payloadFingerprint: 'fp',
        body: { kind: 'message', role: 'user', blocks: [] }
      })
    }
    const untouched = state.submissions.get('send-0')
    const echo = (id: string): JournalRow => ({
      ...base,
      seq: count + 2,
      kind: 'item',
      itemId: `provider:${id}`,
      revision: 1,
      body: { kind: 'message', role: 'user', blocks: [] }
    })
    state.aliases.set(
      'provider:known',
      agentJournalItemKey({ provider: 'orca', clientMessageId: `send-${count - 1}` })
    )
    const values = vi.spyOn(state.submissions, 'values')
    const staged = stageJournalMutation(state, [echo('known')])
    expect(values).not.toHaveBeenCalled()
    expect(staged.submissions.get('send-0')).toBe(untouched)
    expect(staged.submissions.get(`send-${count - 1}`)?.dispatchState).toBe('accepted')
    expect(state.submissions.get(`send-${count - 1}`)?.dispatchState).toBe('pending')
    values.mockRestore()
    const oversized = 'x'.repeat(1100)
    applyJournalRow(state, {
      ...base,
      seq: count + 3,
      kind: 'submission',
      clientMessageId: oversized,
      payloadFingerprint: 'fp',
      body: { kind: 'message', role: 'user', blocks: [] }
    })
    state.aliases.set(
      'provider:digest',
      agentJournalItemKey({ provider: 'orca', clientMessageId: oversized })
    )
    const fallback = stageJournalMutation(state, [echo('digest')])
    expect(fallback.submissions.get(oversized)?.dispatchState).toBe('accepted')
    expect(fallback.submissions.get('send-0')).toBe(untouched)
  }
})
