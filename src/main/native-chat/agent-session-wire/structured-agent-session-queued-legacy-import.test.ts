// An earlier build kept queued cards in their own table. They move into the chat's journal: the
// queue reads each the same before and after, each action moves only its own card, and the bulk
// import runs once per open, all-or-nothing, until no readable legacy row is left.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalAnsweredTurnIdentity,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import { activeProviderContext } from '../../../shared/agent-session-provider-context'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import { structuredAgentSessionCommandTurnIdentity } from '../../../shared/structured-agent-session-command-turn-identity'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { readAgentSessionHistory } from './agent-session-history-page'
import { subscriberHistoryReader } from './agent-session-bounded-frames'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true, rewind: async () => ({ ok: true }) })
})

afterEach(() => rig.dispose())

const db = () => openTestJournalHostDatabase(rig.root).db
const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }],
  ...(text === '/compact' ? { command: { name: 'compact' } } : {})
})
const words = (fact: 'providerRejected' | 'cancelled') =>
  agentSessionFailureWords(
    fact === 'providerRejected'
      ? agentSessionFailureFact(fact, { detail: { text: 'refused', audience: 'person' } })
      : agentSessionFailureFact(fact),
    { surface: 'rejection' }
  )

function journalFor(sessionId: string): AgentSessionJournal {
  return new AgentSessionJournal({
    database: openTestJournalHostDatabase(rig.root),
    identity: {
      sessionId,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: activeProviderContext(rig.store.getRecord(SESSION)!).head!.handle
    }
  })
}

/** An earlier build's hand-off of `card`, answered `as`. */
async function handOff(
  journal: AgentSessionJournal,
  attempt: string,
  card: string,
  text: string,
  as: 'providerRejected' | 'cancelled' | 'accepted',
  fence = 0,
  beforeAnswer?: () => Promise<void>,
  answeredInTurn?: AgentJournalAnsweredTurnIdentity
): Promise<void> {
  const body = message(text)
  const payloadFingerprint = agentSessionSendBodyFingerprint(journal.queuedMessages.sessionId, body)
  await journal.appendSubmission({
    clientMessageId: attempt,
    payloadFingerprint,
    body,
    fence,
    handoverRecorded: true,
    queuedMessageId: card
  })
  await journal.resolveDispatch({
    clientMessageId: attempt,
    state: 'pending',
    fence,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  await beforeAnswer?.()
  await journal.resolveDispatch(
    as === 'accepted'
      ? { clientMessageId: attempt, state: 'accepted', providerIdentity: null, fence }
      : { clientMessageId: attempt, state: 'rejected', ...words(as), fence, answeredInTurn }
  )
}

type Legacy = [id: string, state: string, text: string | null, consumedAs?: string, hold?: string]

function seedLegacy(sessionId: string, rows: readonly Legacy[]): void {
  const insert = db().prepare(
    `INSERT INTO queued_messages (session_id, message_id, position, body_json, fingerprint,
       created_at, host_instance, state, hold_reason, returned_reason, consumed_as)
     VALUES (?, ?, ?, ?, ?, 0, 'earlier', ?, ?, ?, ?)`
  )
  rows.forEach(([id, state, text, consumedAs, hold], index) => {
    const body = text === null ? '{' : JSON.stringify(message(text))
    const print = text === null ? '' : agentSessionSendBodyFingerprint(sessionId, message(text))
    const reason = state === 'returned' ? 'refused before' : null
    insert.run(
      sessionId,
      id,
      index + 1,
      body,
      print,
      state,
      hold ?? null,
      reason,
      consumedAs ?? null
    )
  })
}

const legacyIds = (sessionId = SESSION) =>
  db()
    .prepare('SELECT message_id AS id FROM queued_messages WHERE session_id = ? ORDER BY position')
    .all(sessionId)
    .map((row) => (typeof row === 'object' && row !== null && 'id' in row ? row.id : null))

/** Each queue row on disk: its card, op and whether it saved a refusal. */
function queueRows(sessionId = SESSION): string[] {
  return db()
    .prepare('SELECT row_json FROM journal_rows WHERE session_id = ? ORDER BY seq')
    .all(sessionId)
    .flatMap((row) => {
      const json = typeof row === 'object' && row !== null && 'row_json' in row ? row.row_json : ''
      const parsed: unknown = JSON.parse(String(json))
      if (typeof parsed !== 'object' || parsed === null || !('kind' in parsed)) {
        return []
      }
      if (parsed.kind !== 'queue' || !('messageId' in parsed) || !('change' in parsed)) {
        return []
      }
      const change = JSON.stringify(parsed.change)
      const op = /"op":"(\w+)"/.exec(change)?.[1]
      return [`${String(parsed.messageId)}:${op}${change.includes('"returned"') ? '+refusal' : ''}`]
    })
}

async function nothingSentTo(...cards: string[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100))
  for (const card of cards) {
    expect(await rig.handoff(card)).toBeUndefined()
  }
}

it("moves an earlier build's cards into the journal, each action its own card, the rest once per open", async () => {
  // An earlier build's chat: its hand-offs are journal rows, its cards rows of their own table.
  await rig.drafts()
  await rig.host.close(SESSION, 'evict')
  const earlier = journalFor(SESSION)
  await earlier.open()
  await handOff(earlier, 'att-present', 'ret-present', 'returned here', 'providerRejected')
  await handOff(
    earlier,
    'att-refused',
    'disp-refused',
    'refused, never settled',
    'providerRejected'
  )
  // Stopped after hand-over, which that build sent back to waiting: the agent may have them.
  await handOff(earlier, 'att-stopped', 'stopped-same', 'stopped, unchanged', 'cancelled')
  await handOff(earlier, 'att-edited', 'stopped-edited', 'stopped, then edited', 'cancelled')
  await earlier.close()
  seedLegacy(SESSION, [
    ['ret-present', 'returned', 'returned here, edited', 'att-present'],
    ['ret-gone', 'returned', 'returned in a lost epoch', 'att-gone'],
    ['cmd-gone', 'returned', '/compact', 'att-cmd'],
    ['disp-refused', 'dispatched', 'refused, never settled', 'att-refused'],
    ['stopped-same', 'waiting', 'stopped, unchanged'],
    ['stopped-edited', 'waiting', 'stopped, then edited, changed'],
    ['orphan', 'dispatched', 'its hand-off is gone', 'att-orphan'],
    ['edited', 'waiting', 'waiting, edited'],
    ['held', 'waiting', 'its send failed', undefined, 'send_failed'],
    ['gone', 'withdrawn', 'deleted'],
    ['broken', 'waiting', null]
  ])
  const all = legacyIds()

  // The first open's import fails: nothing moves, and the view reads every card as it will.
  db().exec(`CREATE TEMP TRIGGER fail_import BEFORE DELETE ON queued_messages
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const published = [
    { messageId: 'ret-present', state: 'returned' },
    { messageId: 'ret-gone', state: 'returned' },
    { messageId: 'cmd-gone', state: 'returned' },
    { messageId: 'disp-refused', state: 'returned' },
    { messageId: 'stopped-edited', state: 'waiting', paused: true },
    { messageId: 'edited', state: 'waiting' },
    { messageId: 'held', state: 'waiting', paused: true }
  ]
  expect(await rig.drafts()).toEqual(published)
  const stopped = async () => {
    const { items, submissions } = await rig.host.journalSnapshot(SESSION)
    return projectStructuredAgentSessionMessages(items, [], submissions).find(
      (entry) => entry.id === agentJournalSubmissionKey('att-stopped')
    )
  }
  const live = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const rawStopped = structuredClone(live.submission('att-stopped'))
  const displayedStopped = await stopped()
  expect(displayedStopped).toMatchObject({
    stoppedBeforeStart: true,
    blocks: [{ type: 'text', text: 'stopped, unchanged' }]
  })
  expect(live.submission('att-stopped')).toEqual(rawStopped)
  await nothingSentTo('stopped-same')
  db().exec('DROP TRIGGER fail_import')
  expect(warned).toHaveBeenCalledWith(
    '[journal-open] queued-message import skipped:',
    expect.objectContaining({ sessionId: SESSION })
  )
  warned.mockRestore()
  expect(legacyIds()).toEqual(all)
  expect(queueRows()).toEqual([])

  // Delete and Send each move only their own card, in the action's transaction.
  const deletion = hostTestOperationId()
  expect(await rig.deleteQueued('ret-present', deletion)).toMatchObject({
    value: { deleted: true }
  })
  const sent = await rig.sendNow('ret-gone')
  expect(sent).toMatchObject({ ok: true, value: { submission: { queuedMessageId: 'ret-gone' } } })
  expect(queueRows()).toEqual([
    'ret-present:queued',
    'ret-present:withdrawn',
    'ret-gone:queued+refusal'
  ])
  expect(legacyIds()).toEqual(all.filter((id) => id !== 'ret-present' && id !== 'ret-gone'))
  // The returned cards ahead still hold the queue.
  await nothingSentTo('edited', 'held')

  // The next open moves the rest in one transaction: answered cards write nothing, and a refusal
  // is written only where its hand-off is not in this epoch.
  await rig.restartHostProcess()
  expect(await rig.drafts()).toEqual(published.slice(2))
  expect(legacyIds()).toEqual(['broken'])
  expect(queueRows().slice(3)).toEqual([
    'cmd-gone:queued+refusal',
    'disp-refused:queued',
    'stopped-same:queued',
    'stopped-edited:queued',
    'orphan:queued',
    'edited:queued',
    'held:queued'
  ])
  // Unchanged, it is spent on that hand-off: drawn as the person's send its Stop took back.
  expect(await stopped()).toEqual(displayedStopped)

  // The command card's own turn reports its refusal later: it is spent, not left holding the queue.
  const adopted = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  await adopted.appendItem(
    structuredAgentSessionCommandTurnIdentity('att-cmd'),
    { kind: 'status', text: 'Compact failed' },
    {
      fence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
  expect(await rig.drafts()).toEqual(published.slice(3))
  expect(await rig.deleteQueued('disp-refused')).toMatchObject({ value: { deleted: true } })
  await rig.resume()
  await eventually(async () => expect(await rig.handoff('edited')).toBeDefined())
  await nothingSentTo('held')
  expect((await rig.handoff('stopped-edited'))?.clientMessageId).toBe('att-edited')
  // Edited since, it waits for its own Send.
  expect(await rig.sendNow('stopped-edited')).toMatchObject({ ok: true })
  const resent = await rig.handoffId('stopped-edited')
  expect(resent).not.toBe('att-edited')
  await rig.settleAccepted(resent, 'resent')

  // A third open finds nothing to move, and an old Delete still answers from its receipt.
  const rows = queueRows()
  await rig.restartHostProcess()
  await rig.drafts()
  expect(queueRows()).toEqual(rows)
  expect(await stopped()).toEqual(displayedStopped)
  expect(legacyIds()).toEqual(['broken'])
  expect(await rig.deleteQueued('ret-present', deletion)).toMatchObject({
    replayed: true,
    value: { deleted: true }
  })

  // A chat holding only answered legacy rows has nothing to write: they go in a transaction alone.
  const other = journalFor('session-y')
  await other.open()
  await handOff(other, 'y-att', 'y-sent', 'delivered', 'accepted')
  await other.close()
  seedLegacy('session-y', [
    ['y-gone', 'withdrawn', 'deleted'],
    ['y-sent', 'dispatched', 'delivered', 'y-att']
  ])
  const reopened = journalFor('session-y')
  await reopened.open()
  expect(legacyIds('session-y')).toEqual([])
  expect(queueRows('session-y')).toEqual([])
  expect(reopened.queuedMessages.list()).toEqual([])
  await reopened.close()
})

it.each([100, 1_000])(
  'unchanged caught-up publications do not materialize %i historical items',
  async (size) => {
    const earlier = journalFor(SESSION)
    await earlier.open()
    await handOff(earlier, 'u', 'q', 'stopped words', 'cancelled', 0, async () => {
      for (let ordinal = 0; ordinal < size; ordinal++) {
        await earlier.appendItem(
          { provider: 'codex', threadId: 'history', turnId: 't', ordinal },
          { ...message('old answer'), role: 'assistant' },
          { fence: 0 }
        )
      }
    })
    await earlier.close()
    seedLegacy(SESSION, [['q', 'waiting', 'stopped words']])
    db().exec(`CREATE TEMP TRIGGER b2_perf_fail_import BEFORE DELETE ON queued_messages
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
    const journal = journalFor(SESSION)
    await journal.open()
    db().exec('DROP TRIGGER b2_perf_fail_import')
    const feed = new AgentSessionSubscribers()
    const events: AgentSessionSubscribeEvent[] = []
    let visits = 0
    function counted<T>(iterator: MapIterator<T>): MapIterator<T> {
      const next = iterator.next.bind(iterator)
      iterator.next = (...args) => {
        const result = next(...args)
        if (!result.done) {
          visits++
        }
        return result
      }
      return iterator
    }
    const values = Map.prototype.values
    const entries = Map.prototype[Symbol.iterator]
    const valuesRead = vi.spyOn(Map.prototype, 'values').mockImplementation(function (
      this: Map<unknown, unknown>
    ) {
      return counted(values.call(this))
    })
    const entriesRead = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (
      this: Map<unknown, unknown>
    ) {
      return counted(entries.call(this))
    })
    try {
      feed.open({
        sessionId: SESSION,
        journal,
        fence: 0,
        id: 'perf',
        cursor: journal.cursor(),
        snapshotCatchUp: true,
        readsCurrentRequests: true,
        emit: (event) => events.push(event)
      })
      expect(events[0]?.type).toBe('snapshot')
      expect(visits).toBeGreaterThanOrEqual(size)
      visits = 0
      for (let publication = 0; publication < 5; publication++) {
        feed.publish(SESSION, journal)
      }
      // Only the one subscriber per publish; history copies/materialization would add N visits.
      expect(visits).toBe(5)
    } finally {
      entriesRead.mockRestore()
      valuesRead.mockRestore()
    }
    expect(events.filter((event) => event.type === 'snapshot')).toHaveLength(1)
    await journal.close()
  }
)

it('a rewind while the import has failed moves the legacy cards first: a refused one stays returned', async () => {
  // Made before the clear, which leaves the chat no provider handle to read.
  const earlier = journalFor(SESSION)
  const clear = { command: 'clear' as const }
  expect(
    await rig.host.conversationCommand(CALLER, {
      ...clear,
      envelope: rig.envelope(clear, 'agentSession.conversationCommand', hostTestOperationId())
    })
  ).toMatchObject({ ok: true })
  const target = rig.send('rewound away')
  expect(await target.result).toMatchObject({ ok: true })
  await eventually(async () =>
    expect((await rig.submission(target.id))?.handedOverAt).toBeDefined()
  )
  await rig.settleAccepted(target.id, 'target')
  await rig.host.close(SESSION, 'evict')
  await earlier.open()
  const fence = rig.store.getRecord(SESSION)!.lease.runtimeFence
  await handOff(
    earlier,
    'att-refused',
    'disp-refused',
    'refused, never settled',
    'providerRejected',
    fence
  )
  await earlier.close()
  seedLegacy(SESSION, [
    ['disp-refused', 'dispatched', 'refused, never settled', 'att-refused'],
    ['edited', 'waiting', 'waiting, edited']
  ])
  db().exec(`CREATE TEMP TRIGGER fail_import BEFORE DELETE ON queued_messages
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const held = [
    { messageId: 'disp-refused', state: 'returned' },
    { messageId: 'edited', state: 'waiting' }
  ]
  expect(await rig.drafts()).toEqual(held)
  db().exec('DROP TRIGGER fail_import')
  warned.mockRestore()

  const live = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const rewound = { itemId: agentJournalSubmissionKey(target.id), expectedEpoch: live.epoch }
  expect(
    await rig.host.rewind(CALLER, {
      ...rewound,
      envelope: rig.envelope(rewound, 'agentSession.rewind', hostTestOperationId())
    })
  ).toMatchObject({ ok: true })
  expect(live.epoch).toBe(rewound.expectedEpoch)
  expect(live.submission('att-refused')).toBeUndefined()
  expect(await rig.drafts()).toEqual(held)
  await nothingSentTo('edited')
  expect(legacyIds()).toEqual([])
})

const retainedHistoryCases = [
  { adopt: false, proof: 'none' },
  { adopt: true, proof: 'none' },
  { adopt: false, proof: 'dispatch' },
  { adopt: true, proof: 'dispatch' },
  { adopt: false, proof: 'item' },
  { adopt: true, proof: 'item' }
]
it.each(retainedHistoryCases)('retained history: $adopt / $proof', async ({ adopt, proof }) => {
  const earlier = journalFor(SESSION)
  await earlier.open()
  const append = async (journal: AgentSessionJournal, ordinal: number) => {
    await journal.appendItem(
      { provider: 'codex', threadId: 'history', turnId: 't', ordinal },
      { ...message('x'.repeat(4_000)), role: 'assistant' },
      { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  await append(earlier, 0)
  await handOff(
    earlier,
    'u',
    'q',
    'stopped words',
    'cancelled',
    0,
    async () => {
      for (let index = 1; index <= 205; index++) {
        await append(earlier, index)
      }
    },
    proof === 'none'
      ? undefined
      : {
          turn: { provider: 'codex', threadId: 'history', turnId: 't', ordinal: -1 },
          via: 'steer'
        }
  )
  const stale = readAgentSessionHistory(earlier, { sessionId: SESSION, direction: 'tail' })
  expect(stale.ok).toBe(true)
  await earlier.close()
  seedLegacy(SESSION, [['q', 'waiting', 'stopped words']])
  if (!adopt) {
    db().exec(`CREATE TEMP TRIGGER b2_fail_import BEFORE DELETE ON queued_messages
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  }
  const journal = journalFor(SESSION)
  await journal.open()
  if (!adopt) {
    db().exec('DROP TRIGGER b2_fail_import')
  }
  const queue = { queuedMessages: [], queuePause: null, nextQueuedMessageId: null }
  const feed = new AgentSessionSubscribers({ readQueuePublication: () => queue })
  const base = { sessionId: SESSION, journal, fence: 0 }
  const oldEvents: AgentSessionSubscribeEvent[] = []
  feed.open({
    ...base,
    id: 'old',
    cursor: journal.cursor(),
    snapshotCatchUp: false,
    readsCurrentRequests: false,
    emit: (event) => oldEvents.push(event)
  })
  expect(oldEvents).toEqual([
    {
      type: 'batch',
      sessionId: SESSION,
      fence: 0,
      hostNow: expect.any(Number),
      activity: null,
      ...queue,
      batch: { cursor: journal.cursor(), items: [], removedItemIds: [], submissions: [] }
    }
  ])
  const corrected: AgentSessionSubscribeEvent[][] = []
  const clients: (() => ReturnType<typeof reduceStructuredAgentSession>)[] = []
  for (const boundedFrames of [false, true]) {
    let state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'history-page',
      page: structuredClone(stale.page)
    })
    const events: AgentSessionSubscribeEvent[] = []
    corrected.push(events)
    clients.push(() => state)
    const reader = subscriberHistoryReader({ boundedFrames })
    feed.open({
      ...base,
      id: `new-${boundedFrames}`,
      cursor: journal.cursor(),
      boundedFrames,
      snapshotCatchUp: true,
      readsCurrentRequests: true,
      emit: (event) => {
        events.push(event)
        state = reduceStructuredAgentSession(state, {
          type: 'event',
          event: structuredClone(event)
        })
      }
    })
    expect(events[0]?.type).toBe('snapshot')
    while (state.hasOlder) {
      const requestedCursor = { epoch: journal.epoch, sequence: state.items[0]!.sequence }
      const older = readAgentSessionHistory(
        journal,
        { sessionId: SESSION, direction: 'before', cursor: requestedCursor },
        { reader }
      )
      expect(older.ok).toBe(true)
      state = reduceStructuredAgentSession(state, {
        type: 'older-page',
        requestedCursor,
        page: structuredClone(older.page)
      })
    }
    const canonical = journal.snapshot()
    expect([state.items, state.submissions]).toEqual([canonical.items, canonical.submissions])
    feed.publish(SESSION, journal)
    await append(journal, 205)
    feed.publish(SESSION, journal)
  }
  const cursor = journal.cursor()
  const after = readAgentSessionHistory(journal, {
    sessionId: SESSION,
    direction: 'after',
    cursor
  })
  expect(after).toMatchObject({ ok: false, reset: 'cursor_compacted' })
  if (!adopt) {
    await journal.queuedMessages.importAtOpen()
    feed.publish(SESSION, journal)
  }
  if (proof !== 'none') {
    const placed = journal
      .snapshot()
      .items.find((item) => item.itemId === agentJournalSubmissionKey('u'))
    const loaded = clients.map((client) => client().items.length)
    const normalizationKey = journal.publicRead().normalizationKey
    const identity = {
      provider: 'codex' as const,
      threadId: 'history',
      turnId: 't',
      ordinal: 206
    }
    if (proof === 'dispatch') {
      await journal.acceptLate({
        clientMessageId: 'u',
        state: 'accepted',
        fence: 0,
        providerIdentity: identity
      })
    }
    await journal.appendItem(identity, message('stopped words'), { fence: 0 })
    feed.publish(SESSION, journal)
    expect(journal.submission('u')?.dispatchState).toBe('accepted')
    expect(journal.receiptFor('u')).not.toBeNull()
    expect(journal.publicRead().normalizationKey).toBe(normalizationKey)
    expect(clients.map((client) => client().items.length)).toEqual(loaded)
    for (const client of clients) {
      expect(client().items.find((item) => item.itemId === placed?.itemId)).toMatchObject({
        sequence: placed?.sequence,
        observedAt: placed?.observedAt,
        turnScope: placed?.turnScope,
        revision: 1
      })
      expect(
        client().submissions.find((submission) => submission.clientMessageId === 'u')?.dispatchState
      ).toBe('accepted')
    }
  }
  expect(
    corrected.map((events) => events.filter((event) => event.type === 'snapshot').length)
  ).toEqual([1, 1])
  expect(oldEvents.every((event) => event.type === 'batch')).toBe(true)
  await journal.close()
  const reopened = journalFor(SESSION)
  await reopened.open()
  const resumed: AgentSessionSubscribeEvent[] = []
  new AgentSessionSubscribers().open({
    ...base,
    journal: reopened,
    id: 'reopen',
    cursor: reopened.cursor(),
    snapshotCatchUp: true,
    readsCurrentRequests: true,
    emit: (event) => resumed.push(event)
  })
  expect(resumed[0]?.type).toBe('snapshot')
  await reopened.close()
})
