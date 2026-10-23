import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { iterateJournalEpochRows } from './journal-row-table'
import { parseJournalRow } from './journal-row-schema'
import type { JournalTextPrunedRow } from './journal-text-rows'
import { replayJournal } from './journal-open'
import { projectJournalBatch } from '../agent-session-wire/agent-session-journal-batch'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'

const journals = createTrackedJournalOpener()
const roots: string[] = []
const identity: AgentJournalItemIdentity = {
  provider: 'claude',
  sessionId: 'provider',
  uuid: 'reply'
}
const itemId = agentJournalItemKey(identity)
const body = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text }]
})
const options = { fence: 7, ownerFence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
afterEach(async () => {
  await journals.closeAll()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
async function rig() {
  const root = await mkdtemp(join(tmpdir(), 'orca-text-persistence-'))
  roots.push(root)
  let now = 100
  const settings = {
    stateDirectory: root,
    identity: {
      sessionId: 'chat',
      workspaceId: 'folder',
      hostId: 'host',
      agent: 'claude' as const,
      providerHandle: null
    },
    now: () => now
  }
  const journal = await journals.open(settings)
  const database = openTestJournalHostDatabase(root)
  const rows = () =>
    [...iterateJournalEpochRows(database.db, 'chat', journal.epoch)].map((entry) => {
      const parsed = parseJournalRow(entry.rowJson, true)
      if (!parsed.ok) {
        throw new Error('unreadable test row')
      }
      return parsed.row
    })
  const stream = (baseLength: number, suffix: string, whole: string) =>
    journal.appendItem(identity, body(''), {
      ...options,
      streamText: { field: 0, baseLength, suffix, text: () => whole }
    })
  return {
    root,
    journal,
    database,
    rows,
    stream,
    settings,
    time: (value: number) => {
      now = value
    }
  }
}

it('saves only increments, reopens an interrupted stream, and catches up through certified holes', async () => {
  const r = await rig()
  await r.stream(0, 'hello', 'hello')
  r.time(200)
  await r.stream(5, ' world', 'hello world')
  const delta = r.rows().find((row) => row.kind === 'text-delta')
  expect(delta).toMatchObject({
    v: 5,
    suffix: ' world',
    baseLength: 5,
    predecessor: 1,
    revision: 2
  })
  expect(delta).not.toHaveProperty('body')
  expect(replayJournal(r.database.db, 'chat')?.state.items.get(itemId)?.body).toEqual(
    body('hello world')
  )
  const before = r.journal.snapshot().items[0]
  await r.journal.close()
  const reopened = await journals.open(r.settings)
  expect(reopened.item(itemId)).toEqual(before)
  r.time(300)
  await reopened.appendItem(identity, body('CORRECTED'), options)
  expect(r.rows().some((row) => row.kind === 'text-delta')).toBe(false)
  const proof = r.rows().find((row) => row.kind === 'text-pruned')
  expect(proof).toMatchObject({
    marker: before.sequence,
    revision: 3,
    ranges: [[delta?.seq, delta?.seq]]
  })
  const loaded = replayJournal(r.database.db, 'chat')
  expect(loaded?.damage).toBeNull()
  expect(loaded?.state.items.get(itemId)).toMatchObject({
    sequence: before.sequence,
    observedAt: before.observedAt,
    body: body('CORRECTED')
  })
  const since = reopened.readSince({ epoch: reopened.epoch, sequence: before.sequence })
  if (!since.ok) {
    throw new Error('expected exact catch-up')
  }
  const projected = projectJournalBatch({
    rows: since.rows,
    snapshot: reopened.snapshot(),
    afterSequence: before.sequence,
    coversGap: since.coversGap
  })
  expect(projected).toMatchObject({
    ok: true,
    batch: { items: [{ itemId, body: body('CORRECTED') }] }
  })
  const afterWhole = since.rows.find((row) => row.kind === 'item')?.seq ?? 0
  const tail = reopened.readSince({ epoch: reopened.epoch, sequence: afterWhole })
  if (!tail.ok) {
    throw new Error('expected proof tail')
  }
  expect(
    projectJournalBatch({
      rows: tail.rows,
      snapshot: reopened.snapshot(),
      afterSequence: afterWhole,
      coversGap: tail.coversGap
    })
  ).toMatchObject({ ok: true, batch: { items: [{ itemId }] } })
  r.database.db
    .prepare('DELETE FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?')
    .run('chat', reopened.epoch, proof?.seq)
  expect(replayJournal(r.database.db, 'chat')?.damage).toMatchObject({ cause: 'sequence-gap' })
})

it('retains the last real activity observation under a recovered or different-owner whole', async () => {
  const r = await rig()
  await r.stream(0, 'a', 'a')
  r.time(200)
  await r.stream(1, 'b', 'ab')
  const piece = r.rows().find((row) => row.kind === 'text-delta')
  r.time(300)
  await r.journal.appendItem(identity, body('ab'), { ...options, recovered: true })
  expect(r.rows()).toContainEqual(piece)
  let loaded = replayJournal(r.database.db, 'chat')
  expect(loaded?.damage).toBeNull()
  expect(loaded?.state.providerActivityAt.get(7)).toBe(200)
  r.time(350)
  await r.journal.appendItem(identity, body('ab'), { ...options, executionOwner: 8 })
  loaded = replayJournal(r.database.db, 'chat')
  expect(loaded?.state.providerActivityAt.get(7)).toBe(200)
  expect(r.rows()).toContainEqual(piece)
  r.time(400)
  await r.journal.appendItem(identity, body('ab'), { ...options, executionOwner: 7 })
  expect(r.rows().some((row) => row.kind === 'text-delta')).toBe(false)
  expect(replayJournal(r.database.db, 'chat')?.state.providerActivityAt.get(7)).toBe(400)
})

it('bounds each cleanup transaction and drains remaining pieces while the chat is idle', async () => {
  const r = await rig()
  await r.stream(0, 'a', 'a')
  for (let n = 1; n <= 300; n++) {
    await r.stream(n, 'a', 'a'.repeat(n + 1))
    if (n === 150) {
      const user: AgentJournalMessageItem = {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'next' }]
      }
      await r.journal.queuedMessages.insert({ messageId: 'queued', body: user })
      await r.journal.appendSubmission({
        clientMessageId: 'owed',
        payloadFingerprint: 'fingerprint',
        body: user,
        fence: 7
      })
      await r.journal.resolveDispatch({
        clientMessageId: 'owed',
        fence: 7,
        state: 'unknown',
        reason: 'unconfirmed'
      })
    }
  }
  const control: AgentJournalItemIdentity = { provider: 'orca', clientMessageId: 'control' }
  await r.journal.appendItem(
    control,
    {
      kind: 'approval',
      title: 'Allow?',
      detail: null,
      options: [{ id: 'yes', label: 'Yes' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    options
  )
  r.time(500)
  await r.journal.appendLifecycleBatch({
    settlementId: 'completion',
    fence: 7,
    mutations: [
      { kind: 'item', identity, body: body('a'.repeat(301)), turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    ]
  })
  expect(r.rows().filter((row) => row.kind === 'text-delta')).toHaveLength(44)
  await new Promise<void>((resolve) => setImmediate(resolve))
  await r.journal.readInOrder(() => undefined)
  const proofs = r.rows().filter((row) => row.kind === 'text-pruned')
  expect(proofs).toHaveLength(2)
  for (const proof of proofs) {
    expect(
      proof.ranges.reduce((sum, [first, last]) => sum + last - first + 1, 0)
    ).toBeLessThanOrEqual(256)
  }
  const loaded = replayJournal(r.database.db, 'chat')
  expect(loaded?.damage).toBeNull()
  expect(loaded?.state.items.get(agentJournalItemKey(control))?.body.kind).toBe('approval')
  expect(loaded?.state.queue.cards.get('queued')?.body.blocks).toEqual([
    { type: 'text', text: 'next' }
  ])
  expect(loaded?.state.submissions.get('owed')?.dispatchState).toBe('unknown')
  expect(
    r
      .rows()
      .filter((row) => row.kind === 'queue' || row.kind === 'submission' || row.kind === 'dispatch')
  ).toHaveLength(3)
  const invalid = proofs[0]
  r.database.db
    .prepare('UPDATE journal_rows SET row_json = ? WHERE session_id = ? AND epoch = ? AND seq = ?')
    .run(JSON.stringify({ ...invalid, ranges: [[2, 2]] }), 'chat', r.journal.epoch, invalid.seq)
  expect(replayJournal(r.database.db, 'chat')?.damage).not.toBeNull()
})

it('replays partial pruning across surviving superseded pieces without inventing predecessors', () => {
  const state = createJournalReducerState('chat', 'epoch')
  const anchor = {
    kind: 'item' as const,
    v: 5,
    epoch: 'epoch',
    seq: 2,
    ts: 100,
    fence: 7,
    itemId,
    revision: 1,
    body: body('a'),
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  }
  const proof: JournalTextPrunedRow = {
    kind: 'text-pruned',
    v: 5,
    epoch: 'epoch',
    seq: 7,
    ts: 300,
    fence: 7,
    itemId,
    field: 0,
    marker: 2,
    witness: 6,
    revision: 5,
    ranges: [[3, 3]]
  }
  state.textIndex.certify(proof)
  applyJournalRow(state, anchor)
  const piece = {
    kind: 'text-delta' as const,
    v: 5,
    epoch: 'epoch',
    seq: 4,
    ts: 200,
    fence: 7,
    itemId,
    field: 0,
    predecessor: 2,
    revision: 3,
    baseLength: 2,
    suffix: 'c'
  }
  applyJournalRow(state, piece)
  applyJournalRow(state, { ...anchor, seq: 6, revision: 5, body: body('corrected') })
  expect(state.items.get(itemId)?.body).toEqual(body('corrected'))
  applyJournalRow(state, {
    ...piece,
    seq: 8,
    predecessor: 5,
    revision: 6,
    baseLength: 9,
    suffix: '!'
  })
  applyJournalRow(state, {
    ...piece,
    seq: 9,
    predecessor: 5,
    revision: 6,
    baseLength: 9,
    suffix: '!'
  })
  expect(state.items.get(itemId)?.body).toEqual(body('corrected!'))
  expect(() => applyJournalRow(state, { ...piece, seq: 10, revision: 7 })).toThrow(
    'journal_text_predecessor_missing'
  )
})
