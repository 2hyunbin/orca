import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  fakeClaude,
  identityFor as claudeIdentity,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import { MOVED_TO_BACKGROUND } from '../../claude/claude-captured-task-frames.test-fixture'
import {
  acquireReadyCodexForTest,
  adapterFor as codexAdapterFor,
  fakeCodex,
  identityFor,
  THREAD_ID
} from '../../codex/codex-structured-session-adapter-fixture'
import {
  spawn as capturedCodexSpawn,
  turn as capturedCodexTurn,
  PARENT_TURN,
  HELPER,
  HELPER_TURN
} from '../../codex/codex-collab-call-frames-fixture'
import type { StructuredAgentSessionChildWorkProducer } from '../agent-session-wire/structured-agent-session-subagent-rows'
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
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { journalPragmaNumber } from './journal-database'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
import { journalDatabasePath } from './journal-host-database'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { readJournalRestFacts } from './journal-row-table'
import { agentSessionCurrentContextRows } from '../../../shared/agent-session-context-clear'
import { latestStructuredAgentSessionRequest } from '../../../shared/structured-agent-session-latest-request'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { applyJournalRow, createJournalReducerState, renderJournalState } from './journal-reducer'
import { stageJournalMutation } from './journal-mutation-stage'
import type { JournalRow } from './journal-row-schema'
import { openAgentSessionJournal } from './journal-store-factory'
import { semanticWorkRecordId } from '../../../shared/agent-session-semantic-work'

import { AcpStructuredLane } from '../../acp/acp-structured-lane'
import { GROK_ACP_DIALECT } from '../../acp/acp-dialects/grok-dialect'
import { readAcpFixture } from '../../acp/acp-timeline-fixture.test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../agent-session-wire/structured-agent-session-logger-test-support'
import { providerTimelineSink } from '../agent-session-timeline/provider-timeline-plan'
import { StructuredAgentSessionStatusOwnership } from '../agent-session-wire/structured-agent-session-status-ownership'

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

it.each(['s'.repeat(1_500_001), ' ', '\0\ud800', 'x~orca-oversized~1025~0123456789abcdef'])(
  'retains the raw acceptance through lifecycle release/rehold and reopen',
  async (clientMessageId) => {
    let journal = await openJournal()
    await journal.appendSubmission({
      clientMessageId,
      payloadFingerprint: 'raw-source',
      fence: 1,
      body: { kind: 'message', role: 'user', blocks: [] }
    })
    const source = { kind: 'submission', clientMessageId } as const
    const identity = {
      provider: 'legacy',
      agent: 'codex',
      sessionId: SESSION,
      recordId: semanticWorkRecordId(source)
    } as const
    for (const phase of ['settled', 'open'] as const) {
      const body = {
        kind: 'semantic-work',
        version: 1,
        source,
        startedAt: STARTED_AT,
        phase
      } as const
      for (const [address, value] of [
        [{ ...identity, sessionId: 'wrong' }, body],
        [identity, { ...body, source: { ...body.source, clientMessageId: 'missing' } }],
        [
          {
            ...identity,
            recordId: semanticWorkRecordId({ ...source, clientMessageId: 'other' })
          },
          { ...body, startedAt: STARTED_AT + 1 }
        ]
      ] as const) {
        await expect(journal.appendItem(address, value, { fence: 1 })).rejects.toThrow()
      }
      await journal.appendLifecycleBatch({
        settlementId: phase,
        fence: 1,
        mutations: [{ kind: 'item', identity, turnScope: AGENT_JOURNAL_THREAD_SCOPE, body }]
      })
      const expected =
        phase === 'open' ? { itemId: agentJournalItemKey(identity), since: STARTED_AT } : null
      expect(openTurn()).toEqual(expected)
      await journal.close()
      journal = await openJournal()
      expect(journal.submission(clientMessageId)?.clientMessageId).toBe(clientMessageId)
      expect(journal.restFact()).toEqual(expected)
    }
    await journal.close()
  }
)

it.each(['open', 'queue', 'text'])(
  'initializes an already-final schema4 cut through %s, atomically and without gating open',
  async (mode) => {
    let journal = await openJournal()
    await journal.appendItem(turnIdentity('t1'), turn('t1', 'interrupted'), { fence: 1 })
    const assistant = { ...turnIdentity('t1'), ordinal: 1 }
    const text = (value: string) =>
      ({ kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }) as const
    await journal.appendItem(assistant, text('old'), { fence: 1 })
    await journal.close()
    closeTestJournalHostDatabases()
    const old = new Database(journalDatabasePath(root))
    old.exec(
      'ALTER TABLE journal_sessions DROP COLUMN open_turn_id; ALTER TABLE journal_sessions DROP COLUMN open_turn_since; PRAGMA user_version = 4'
    )
    old.close()
    const database = openTestJournalHostDatabase(root)
    expect(journalPragmaNumber(database.db, 'user_version')).toBe(JOURNAL_DB_SCHEMA_VERSION)
    expect(openTurn()).toBeNull()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const transaction = database.transaction.bind(database)
    if (mode !== 'open') {
      vi.spyOn(database, 'transaction').mockImplementationOnce(() => {
        throw new Error('advisory repair failed')
      })
    }
    journal = await openJournal()
    const cut = journal.restFact()
    expect(cut?.itemId).toBe(agentJournalItemKey(turnIdentity('t1')))
    if (mode !== 'open') {
      expect(warn).toHaveBeenCalled()
      expect(openTurn()).toBeNull()
      const previous = journal.snapshot()
      const append = () =>
        mode === 'queue'
          ? journal.appendQueueReopen(1)
          : journal.appendItem(assistant, text('next'), { fence: 1 })
      vi.spyOn(database, 'transaction').mockImplementationOnce((run, streamed) =>
        transaction((db) => {
          expect(streamed).toBe(false)
          run(db)
          expect(openTurn()).toEqual(cut)
          throw new Error('core commit failed')
        })
      )
      await expect(append()).rejects.toThrow('core commit failed')
      expect(journal.snapshot()).toEqual(previous)
      expect(openTurn()).toBeNull()
      await append()
    }
    expect(openTurn()).toEqual(cut)
    const sql = vi.spyOn(database.db, 'prepare')
    const durable = vi.spyOn(database, 'transaction')
    await journal.appendItem(assistant, text('coherent'), { fence: 1 })
    expect(durable.mock.calls.at(-1)?.[1]).toBe(true)
    expect(sql.mock.calls.some(([query]) => query.startsWith('UPDATE journal_sessions'))).toBe(
      false
    )
    sql.mockRestore()
    durable.mockRestore()
    warn.mockRestore()
    await journal.close()
    journal = await openJournal()
    expect(openTurn()).toEqual(cut)
    await journal.close()
  }
)

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
  await write('t2', 'completed', 'failure')
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
  for (const fields of [
    { itemId: 't1', revision: 2, body: turn('t1', 'interrupted') },
    {
      itemId: 'cmd',
      revision: 1,
      body: { kind: 'message', role: 'user', blocks: [], command: { name: 'compact' } } as const
    },
    { itemId: 'tc', revision: 1, body: { ...turn('tc', 'completed'), userItemId: 'cmd' } },
    { itemId: 'sub', revision: 1, agentId: 'child', body: turn('sub', 'completed') },
    { itemId: 'sub', revision: 2, body: turn('sub', 'interrupted') },
    { itemId: 't1', revision: 1, body: turn('t1', 'completed') }
  ]) {
    apply({ kind: 'item', ...fields })
  }
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
      const assistant = { ...turnIdentity('live'), ordinal: 1 } as const
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

it.each(['success', 'core-failure', 'closed'] as const)(
  'retains the real ACP normalized suffix with an admitted prefix and truthful %s barrier',
  async (mode) => {
    const openGrok = () =>
      openAgentSessionJournal({
        identity: {
          sessionId: SESSION,
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: 'grok',
          providerHandle: { transport: 'acp', agent: 'grok', nativeId: 'session-1' }
        },
        database: openTestJournalHostDatabase(root),
        now: () => STARTED_AT
      })
    const request = (recordId: string) =>
      ({ provider: 'legacy', agent: 'grok', sessionId: SESSION, recordId }) as const
    const journal = await openGrok()
    await journal.appendItem(request('before'), turn('before', 'completed'), { fence: 1 })
    const deferred = createDeferredStructuredAgentSessionEventSink({
      ...testEventSinkLogging(SESSION),
      watermarks: { maxLifecycleQueuedOperations: 2 }
    })
    const ownership = new StructuredAgentSessionStatusOwnership(() => undefined)
    const observed = vi.spyOn(ownership, 'publishChildWork')
    const failures = vi.fn()
    const lane = new AcpStructuredLane({
      sink: providerTimelineSink(deferred.sink)!,
      sessionId: SESSION,
      agent: 'grok',
      agentName: 'Grok',
      generation: 'capture',
      providerSessionId: 'session-1',
      dialect: GROK_ACP_DIALECT,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onInputAccepted: vi.fn(),
      onFailed: failures,
      onChildWorkFailure: failures,
      onChildWorkEvidence: (evidence) =>
        ownership.publishChildWork(SESSION, evidence, 'grok', deferred.sink, {
          journal,
          scope: () => AGENT_JOURNAL_THREAD_SCOPE
        })
    })
    deferred.bind({
      journal,
      fence: 1,
      publish: () => {
        throw new Error('optional display')
      }
    })
    const frames = await readAcpFixture('s7-subagent-background')
    lane.apply(lane.translator.openPrompt('p1:4', 600).events)
    const prefix = frames[2].message
    lane.apply(lane.translator.notification(prefix.method!, prefix.params, 600))
    expect(deferred.state().queuedOperations).toBeGreaterThan(0)
    const frame = frames.find(
      ({ message }) =>
        message.method === '_x.ai/session_notification' &&
        JSON.stringify(message.params).includes('subagent_spawned')
    )!
    lane.apply(lane.translator.notification(frame.message.method!, frame.message.params, 700))
    expect(observed).toHaveBeenCalledTimes(1)
    await journal.appendItem(request('later'), turn('later', 'completed'), { fence: 1 })
    expect(
      journal.snapshot().items.some(({ body }) => readAgentJournalTurn(body)?.state === 'running')
    ).toBe(true)
    if (mode === 'core-failure') {
      vi.spyOn(openTestJournalHostDatabase(root), 'transaction').mockImplementationOnce(() => {
        throw new Error('core failure')
      })
    }
    if (mode === 'closed') {
      deferred.close()
    }
    if (mode !== 'success') {
      await expect(lane.written()).resolves.toMatchObject({ ok: false })
      expect(journal.snapshot().items.filter(({ body }) => body.kind === 'semantic-work')).toEqual(
        []
      )
      lane.dispose()
      await expect(lane.written()).resolves.toMatchObject({ ok: false })
      await journal.close()
      return
    }
    await expect(lane.written()).resolves.toEqual({ ok: true })
    expect(observed).toHaveBeenCalledTimes(1)
    const work = journal.snapshot().items.filter(({ body }) => body.kind === 'semantic-work')
    expect(work).toHaveLength(1)
    expect(work[0].body).toMatchObject({
      startedAt: 700,
      phase: 'open',
      source: { handleId: 'subagent-1' }
    })
    lane.apply(lane.translator.promptResult('p1:4', { stopReason: 'end_turn' }, 800))
    await expect(lane.written()).resolves.toEqual({ ok: true })
    lane.dispose()
    await expect(lane.written()).resolves.toEqual({ ok: true })
    const ended = journal.item(work[0].itemId)!
    expect(ended.body).toMatchObject({
      phase: 'interrupted',
      startedAt: 700,
      afterRequest: agentJournalItemKey(request('later'))
    })
    expect(openTurn()).toEqual({ itemId: ended.itemId, since: 700 })
    expect(failures).not.toHaveBeenCalled()
    await journal.close()
    const reopened = await openGrok()
    expect(reopened.item(ended.itemId)?.body).toEqual(ended.body)
    expect(reopened.restFact()).toEqual(openTurn())
    await reopened.close()
  }
)

it.each(['close', 'exit', 'core-failure', 'closed'])(
  'keeps Codex normalized helper admission truthful through pressure and %s',
  async (mode) => {
    const identity = identityFor(SESSION)
    const journal = await openAgentSessionJournal({
      identity,
      database: openTestJournalHostDatabase(root),
      now: () => STARTED_AT
    })
    const deferred = createDeferredStructuredAgentSessionEventSink({
      ...testEventSinkLogging(SESSION),
      watermarks: { maxLifecycleQueuedOperations: 2 }
    })
    deferred.bind({ journal, fence: 7, publish: vi.fn() })
    const codex = fakeCodex()
    const pause = vi.fn()
    const request = (id: string) => ({ ...turnIdentity(id), threadId: THREAD_ID })
    const owner = new StructuredAgentSessionStatusOwnership(() => undefined)
    const observed = vi.spyOn(owner, 'publishChildWork')
    let producer: StructuredAgentSessionChildWorkProducer | undefined
    const adapter = codexAdapterFor(codex, {}, [], {
      openConnection: async (...args) => {
        const connection = await codex.openConnection(...args)
        connection.pauseReading = pause
        connection.resumeReading = vi.fn()
        return connection
      },
      readProcessStartTime: async () => STARTED_AT,
      now: () => STARTED_AT,
      onChildWorkEvidence: (_id, evidence, actual) => {
        producer = actual
        return owner.publishChildWork(SESSION, evidence, 'codex', actual, {
          journal,
          scope: () => AGENT_JOURNAL_THREAD_SCOPE
        })
      }
    })
    await acquireReadyCodexForTest(adapter, {
      identity,
      fence: 7,
      spawnToken: 'spawn-contract',
      events: deferred.sink
    })
    await deferred.drained()
    for (const first of [
      capturedCodexTurn('turn/started', THREAD_ID, PARENT_TURN),
      capturedCodexSpawn('item/started'),
      capturedCodexSpawn('item/completed'),
      capturedCodexTurn('turn/completed', THREAD_ID, PARENT_TURN)
    ]) {
      codex.connections[0].handlers.onNotification?.(first.method, first.params)
      await deferred.drained()
    }
    await new Promise((resolve) => setImmediate(resolve))
    expect(observed).not.toHaveBeenCalled()
    expect(
      deferred.sink.tryAppendLifecycleBatch?.('actual-prefix', [
        { kind: 'item', identity: request('prefix'), body: turn('prefix', 'completed') }
      ])
    ).toEqual({ accepted: true })
    expect(
      deferred.sink.tryAppendLifecycleBatch?.('second-prefix', [
        { kind: 'item', identity: request('prefix'), body: turn('prefix', 'completed') }
      ])
    ).toEqual({ accepted: true })
    const frame = capturedCodexTurn('turn/started', HELPER, HELPER_TURN)
    const connection = codex.connections[0]
    connection.handlers.onNotification?.(frame.method, frame.params)
    expect(observed).toHaveBeenCalledOnce()
    expect(pause).toHaveBeenCalled()
    const observation = observed.mock.calls[0][1]
    expect(observed.mock.results[0].value).toMatchObject({
      accepted: false,
      reason: 'backpressure'
    })
    const later = journal.appendItem(request('later'), turn('later', 'completed'), { fence: 7 })
    if (mode === 'closed') {
      deferred.close()
    }
    await later
    if (mode === 'core-failure') {
      vi.spyOn(openTestJournalHostDatabase(root), 'transaction').mockImplementationOnce(() => {
        throw new Error('Codex core failed')
      })
    }
    if (mode === 'exit') {
      connection.handlers.onExit?.(new Error('captured owner ended'))
    }
    if (mode === 'core-failure' || mode === 'closed') {
      await expect(producer?.written?.()).resolves.toMatchObject({ ok: false })
      await adapter.closeSession(SESSION)
      await expect(producer?.written?.()).resolves.toMatchObject({ ok: false })
      await journal.close()
      return
    }
    await expect(producer?.written?.()).resolves.toEqual({ ok: true })
    const work = journal.snapshot().items.filter(({ body }) => body.kind === 'semantic-work')
    expect(work).toHaveLength(1)
    expect(work[0].body).toMatchObject({
      source: { kind: 'child' },
      startedAt: STARTED_AT,
      phase: mode === 'exit' ? 'interrupted' : 'open'
    })
    expect(observed.mock.calls[0][1]).toBe(observation)
    if (mode === 'close') {
      await adapter.closeSession(SESSION)
    }
    await expect(producer?.written?.()).resolves.toEqual({ ok: true })
    const ended = journal.item(work[0].itemId)!
    expect(ended.body).toMatchObject({
      phase: 'interrupted',
      afterRequest: agentJournalItemKey(request('later'))
    })
    expect(openTurn()).toEqual({ itemId: work[0].itemId, since: STARTED_AT })
    vi.spyOn(openTestJournalHostDatabase(root), 'transaction').mockImplementationOnce(() => {
      throw new Error('later Codex SQL failed')
    })
    expect(
      producer?.tryAppendItem?.(request('later'), turn('later', 'completed'), {
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    ).toEqual({ accepted: true })
    await expect(deferred.sink.written?.()).resolves.toMatchObject({ ok: false })
    await expect(producer?.written?.()).resolves.toMatchObject({ ok: false })
    deferred.close()
    await journal.close()
  }
)

it('holds the original Claude SDK read binding until its normalized work suffix commits', async () => {
  const identity = claudeIdentity()
  const journal = await openAgentSessionJournal({
    identity,
    database: openTestJournalHostDatabase(root),
    now: () => STARTED_AT
  })
  const deferred = createDeferredStructuredAgentSessionEventSink({
    ...testEventSinkLogging(SESSION),
    watermarks: { maxLifecycleQueuedOperations: 1 }
  })
  deferred.bind({ journal, fence: 7, publish: vi.fn() })
  const claude = fakeClaude()
  const owner = new StructuredAgentSessionStatusOwnership(() => undefined)
  const observed = vi.spyOn(owner, 'publishChildWork')
  let producer: StructuredAgentSessionChildWorkProducer | undefined
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo',
      claudeConfigDir: '/accounts/claude',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false
    }),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => STARTED_AT,
    now: () => STARTED_AT,
    persistHandle: async () => {},
    onChildWorkEvidence: (_id, evidence, actual) => {
      producer = actual
      return owner.publishChildWork(SESSION, evidence, 'claude', actual, {
        journal,
        scope: () => AGENT_JOURNAL_THREAD_SCOPE
      })
    }
  })
  await adapter.acquire({ identity, fence: 7, spawnToken: 'spawn-claude', events: deferred.sink })
  await deferred.drained()
  const request = (recordId: string) =>
    ({ provider: 'legacy', agent: 'claude', sessionId: SESSION, recordId }) as const
  expect(
    deferred.sink.tryAppendLifecycleBatch?.('claude-prefix', [
      { kind: 'item', identity: request('prefix'), body: turn('prefix', 'completed') }
    ])
  ).toEqual({ accepted: true })
  const connection = claude.connections[0]
  const pause = vi.spyOn(connection, 'pauseReading')
  const resume = vi.spyOn(connection, 'resumeReading')
  connection.handlers.onMessage?.({
    ...MOVED_TO_BACKGROUND[1].frame,
    session_id: PROVIDER_SESSION_ID,
    uuid: 'captured-task-start'
  })
  expect(observed).toHaveBeenCalledOnce()
  expect(pause).toHaveBeenCalled()
  expect(resume).not.toHaveBeenCalled()
  await journal.appendItem(request('later'), turn('later', 'completed'), { fence: 7 })
  await expect(producer?.written?.()).resolves.toEqual({ ok: true })
  expect(observed).toHaveBeenCalledOnce()
  expect(resume).toHaveBeenCalled()
  const work = journal.snapshot().items.filter(({ body }) => body.kind === 'semantic-work')
  expect(work).toHaveLength(1)
  expect(work[0].body).toMatchObject({
    startedAt: STARTED_AT,
    source: { handleId: 'agent-1' },
    phase: 'open'
  })
  await adapter.closeSession(SESSION)
  await expect(producer?.written?.()).resolves.toEqual({ ok: true })
  expect(journal.item(work[0].itemId)?.body).toMatchObject({
    phase: 'interrupted',
    afterRequest: agentJournalItemKey(request('later'))
  })
  deferred.close()
  await journal.close()
})
