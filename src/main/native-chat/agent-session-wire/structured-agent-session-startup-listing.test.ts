vi.mock('../agent-session-journal/journal-legacy-rest-worker', async () => {
  const { InProcessLegacyRestWorker } =
    await import('../agent-session-journal/journal-legacy-rest-replay-test-support')
  return { JournalLegacyRestWorker: InProcessLegacyRestWorker }
})

import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { publishHeadlessRuntimeGraph } from '../../runtime/headless-runtime-graph'
import { createOrchestrationRpcHarness } from '../../runtime/rpc/methods/orchestration/rpc-test-harness'
import { createRootDispatch } from '../../runtime/orchestration/db/root-dispatch-test-fixture'
import { createStructuredMailboxPointerHost } from '../../runtime/orchestration/structured-mailbox-pointer-host'
import {
  beginStructuredJournalForeground,
  structuredJournalBackgroundReady,
  setStructuredAgentSessionHost
} from './structured-agent-session-registry'
import { JournalLegacyRestInitializer } from '../agent-session-journal/journal-legacy-rest-initializer'
import { readJournalRestFacts } from '../agent-session-journal/journal-row-table'
import { agentSessionLeaseFixture } from '../../../shared/agent-session-record.test-fixture'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../../runtime/structured-worker-identity'
import { sendAgentTurn } from '../../runtime/orchestration/send-agent-turn'
import { agentSessionProviderHandleRoot } from '../../../shared/agent-session-provider-handle-encoding'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { HOST_TEST_LOCATION as LOCATION } from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import { marker } from './structured-agent-session-restart-resume-test-harness'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'

const NOW = 1_800_000_000_000
const CUT = 'chat-cut-by-crash'
const DONE = 'chat-done'
const LEGACY_WORKING = 'chat-working-at-quit'
const NEVER_SENT = 'chat-never-sent'
const UNWRITTEN = 'chat-without-journal'

let root: string
let host: StructuredAgentSessionHost

const record = (sessionId: string): AgentSessionRecord =>
  agentSessionRecordFixture({
    sessionId,
    location: LOCATION,
    conversationName: `name of ${sessionId}`,
    providerHandleChain: [
      {
        linkId: `${sessionId}-link`,
        handle: claudeProviderHandle(`${sessionId}-provider`, null),
        origin: 'created',
        mintedAtFence: 1,
        observedAt: NOW
      }
    ]
  })

/** The chat's journal as its last host left it: a sent prompt and a turn in `turn`'s state. */
async function seedJournal(sessionId: string, turn: 'running' | 'completed' | null): Promise<void> {
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId,
      workspaceId: LOCATION.workspaceId,
      hostId: LOCATION.executionHostId,
      agent: 'claude',
      providerHandle: claudeProviderHandle(`${sessionId}-provider`, null)
    },
    database: openTestJournalHostDatabase(root),
    now: () => NOW
  })
  if (turn) {
    await journal.appendSubmission({
      clientMessageId: `${sessionId}-send`,
      payloadFingerprint: '0'.repeat(64),
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: `ask ${sessionId}` }] },
      fence: 1
    })
    await journal.appendItem(
      { provider: 'claude', sessionId: `${sessionId}-provider`, uuid: 'turn' },
      {
        kind: 'turn',
        turnId: 'turn-1',
        state: turn,
        startedAt: NOW,
        userItemId: `orca:${sessionId}-send`
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  await journal.close()
}

function installAcquisitionFixture(): void {
  host.deps.adapter.acquire = async ({ identity, fence, spawnToken }) => ({
    acquisitionGeneration: 'generation',
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: NOW,
      spawnToken
    },
    link: {
      linkId: 'acquired',
      handle: claudeProviderHandle(`${identity.sessionId}-provider`, null),
      origin: 'resumed',
      mintedAtFence: fence,
      observedAt: NOW
    }
  })
  host.deps.adapter.releaseAcquisition = async () => true
  host.deps.adapter.cancelTurn = async () => ({ cancelled: true })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-startup-listing-'))
  const chats = [CUT, DONE, LEGACY_WORKING, NEVER_SENT, UNWRITTEN]
  await seedTestAgentSessionRecordStore(root, { records: chats.map(record) })
  await seedJournal(CUT, 'running')
  await seedJournal(DONE, 'completed')
  await seedJournal(LEGACY_WORKING, 'running')
  await seedJournal(NEVER_SENT, null)
  openTestJournalHostDatabase(root)
    .db.prepare('UPDATE journal_sessions SET open_turn_id = NULL WHERE session_id = ?')
    .run(LEGACY_WORKING)
  const capsule = new AgentSessionRecoveryCapsule(root)
  await capsule.record([marker({ sessionId: LEGACY_WORKING, recordedAt: NOW })], NOW)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store: await openTestAgentSessionRecordStore(root),
    adapter: {
      open: async () => ({ reportedOptions: { model: '' } }),
      acquire: vi.fn(),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn(),
      supportsCreate: () => true
    },
    journalDatabase: openTestJournalHostDatabase(root),
    recoveryCapsule: capsule,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-2',
    idleSweep: { maxResident: 2 },
    now: () => NOW + 60_000
  })
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  structuredWorkerIdentities.clear()
  vi.restoreAllMocks()
  await host.flushAllStreamedEvents()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

it('initializes an unknown legacy chat only after responsiveness, yielding to a real foreground use', async () => {
  const { db } = host.deps.journalDatabase
  db.prepare(
    'UPDATE journal_sessions SET open_turn_id = NULL, open_turn_since = NULL WHERE session_id = ?'
  ).run(CUT)
  const sink: AgentSessionStatusSummary[] = []
  const stream: AgentSessionStatusSummary[] = []
  host.deps.statusSink = { publish: (row) => sink.push(row), forget: () => {} }
  host.subscribeStatus({
    id: 'upgrade',
    emit: (event) => {
      if (event.type === 'status') {
        stream.push(event.session)
      }
    }
  })
  const opened = vi.spyOn(AgentSessionJournal.prototype, 'open')
  const advance = vi.spyOn(JournalLegacyRestInitializer.prototype, 'advance')
  const sql = vi.spyOn(db, 'prepare')
  const rowReads = () =>
    sql.mock.calls.filter(([query]) => query.includes('ORDER BY seq ASC LIMIT'))
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'openAgentSessionRecordStore').mockResolvedValue(host.deps.store)
  setStructuredAgentSessionHost(host)
  await host.restoreReadableSessions([CUT])
  expect(sink.at(-1)).toMatchObject({ sessionId: CUT, status: null })
  expect(rowReads()).toHaveLength(0)
  runtime.noteAgentLaunchStartupSettled()
  runtime.noteAgentLaunchClientReady()
  const graph = { tabs: [], leaves: [], rendererGeneration: 'first' }
  runtime.syncWindowGraph(17, graph)
  expect(structuredJournalBackgroundReady()).toBe(false)
  expect(rowReads()).toHaveLength(0)
  const foreground = beginStructuredJournalForeground()
  runtime.syncWindowGraph(17, { ...graph, startupRestorationReady: true })
  await advance.mock.results.at(-1)?.value
  expect(rowReads()).toHaveLength(0)
  expect(readJournalRestFacts(db, CUT)?.known).toBe(false)
  foreground()
  await advance.mock.results.at(-1)?.value
  expect(rowReads().length).toBeGreaterThan(0)
  expect(readJournalRestFacts(db, CUT)?.openTurn?.since).toBe(NOW)
  for (const rows of [sink, stream]) {
    expect(rows.at(-1)).toMatchObject({
      sessionId: CUT,
      turnOutcome: 'cancellation',
      restoredInterruption: true,
      statusStartedAt: NOW
    })
  }
  expect(opened).not.toHaveBeenCalled()
  runtime.markRendererReloading(17)
  expect(structuredJournalBackgroundReady()).toBe(false)
  expect(() => runtime.syncWindowGraph(17, { ...graph, startupRestorationReady: true })).toThrow(
    'superseded'
  )
  expect(() =>
    runtime.syncWindowGraph(18, {
      ...graph,
      rendererGeneration: 'foreign',
      startupRestorationReady: true
    })
  ).toThrow('authoritative')
  runtime.syncWindowGraph(17, { ...graph, rendererGeneration: 'replacement' })
  expect(structuredJournalBackgroundReady()).toBe(false)
  runtime.syncWindowGraph(17, {
    ...graph,
    rendererGeneration: 'replacement',
    startupRestorationReady: true
  })
  expect(structuredJournalBackgroundReady()).toBe(true)
  const windowless = new OrcaRuntimeService()
  publishHeadlessRuntimeGraph(windowless)
  expect(structuredJournalBackgroundReady()).toBe(false)
  windowless.noteHeadlessStartupReady()
  expect(structuredJournalBackgroundReady()).toBe(true)
  windowless.attachWindow(19)
  expect(structuredJournalBackgroundReady()).toBe(false)
  windowless.syncWindowGraph(19, { ...graph, startupRestorationReady: true })
  expect(structuredJournalBackgroundReady()).toBe(true)
  const count = rowReads().length
  host.advanceLegacyRest()
  await advance.mock.results.at(-1)?.value
  expect(rowReads()).toHaveLength(count)
})

it('lists every restored chat as Interrupted or Done, on every status surface, opening none', async () => {
  const sunk: AgentSessionStatusSummary[] = []
  host.deps.statusSink = {
    publish: (summary) => sunk.push(summary),
    forget: () => {},
    readChildWork: () => []
  }
  const opened = vi.spyOn(AgentSessionJournal.prototype, 'open')

  await host.restoreReadableSessions([CUT, DONE, LEGACY_WORKING, NEVER_SENT, UNWRITTEN])

  expect(opened).not.toHaveBeenCalled()
  expect(host.listSessionTabs().map((tab) => tab.sessionId)).toEqual([
    CUT,
    DONE,
    LEGACY_WORKING,
    NEVER_SENT
  ])
  let snapshot: AgentSessionStatusSummary[] = []
  host.subscribeStatus({
    id: 'sidebar',
    emit: (event) => {
      if (event.type === 'snapshot' && event.sessions.length > 0) {
        snapshot = event.sessions
      }
    }
  })
  const rows = (summaries: AgentSessionStatusSummary[]) =>
    summaries.map((row) => [row.sessionId, row.status, row.turnOutcome, row.conversationName])
  const expected = [
    [CUT, 'idle', 'cancellation'],
    [DONE, 'idle', undefined],
    [LEGACY_WORKING, 'idle', 'cancellation'],
    [NEVER_SENT, null, undefined]
  ].map((row) => [...row, `name of ${row[0]}`])
  expect(rows(snapshot)).toEqual(expected)
  expect(rows(sunk)).toEqual(expected)
  expect([CUT, DONE, LEGACY_WORKING, NEVER_SENT].some(host.hasSession)).toBe(false)
})

it('classifies explicit Run targets serially through real ownership despite 25 failed ended-owner releases', async () => {
  const victims = Array.from({ length: 25 }, (_, i) => `ended-owner-victim-${i}`)
  const candidates = Array.from({ length: 30 }, (_, i) => `explicit-candidate-${i}`)
  await seedTestAgentSessionRecordStore(root, {
    sessionTabs: [...victims, ...candidates, CUT, DONE, UNWRITTEN].map((sessionId) => ({
      tabId: `tab-${sessionId}`,
      sessionId
    })),
    records: [...victims, ...candidates, CUT, DONE, UNWRITTEN].map((id) => ({
      ...record(id),
      ...(victims.includes(id) || id === CUT || id === DONE
        ? {
            lease: agentSessionLeaseFixture({
              sessionId: id,
              runtimeFence: 1,
              provenHandleLinkId: `${id}-link`
            })
          }
        : {})
    }))
  })
  host = new StructuredAgentSessionHost({
    ...host.deps,
    store: await openTestAgentSessionRecordStore(root),
    idleSweep: { maxResident: 24 }
  })
  setStructuredAgentSessionHost(host)
  const { sessions, lifetime } = host.collaboratorsForTests()
  const transitionHandoff = host.deps.store.transitionHandoff
  vi.spyOn(host.deps.store, 'transitionHandoff').mockImplementation((id, transition) =>
    victims.includes(id)
      ? Promise.reject(new Error('release write failed'))
      : transitionHandoff(id, transition)
  )
  for (const id of victims) {
    expect(host.deps.store.getRecord(id), id).not.toBeNull()
    await seedJournal(id, 'completed')
    await host.withConversationUse(id, async () => {
      await host.journalSnapshot(id)
      sessions.get(id)!.lastEndedChild = {
        generation: null,
        fence: 1,
        rootGone: true,
        cause: 'exit',
        reason: null,
        duringStartup: false,
        endedAt: sessions.get(id)!.journal.cursor()
      }
    })
  }
  installAcquisitionFixture()
  host.deps.adapter.dispatch = async (input) => {
    await input.beforeDispatch?.()
    return { state: 'accepted', providerIdentity: null }
  }
  for (const id of [CUT, DONE]) {
    const sent = await sendAgentTurn({
      kind: 'structured-session',
      host,
      sessionId: id,
      callerKey: 'trusted-local:orchestration:test',
      turn: {
        delivery: 'now',
        operationId: `${NOW}-${id === CUT ? '1'.repeat(32) : '2'.repeat(32)}`,
        expectedRuntimeFence: host.deps.store.getRecord(id)!.lease.runtimeFence,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'current request' }] }
      }
    })
    expect(sent).toMatchObject({ kind: 'sent', submission: { dispatchState: 'accepted' } })
    expect(sessions.get(id)?.child?.fence).toBeGreaterThan(1)
    const fence = host.deps.store.getRecord(id)!.lease.runtimeFence
    await sessions
      .get(id)!
      .journal.appendItem(
        { provider: 'claude', sessionId: `${id}-provider`, uuid: 'successor-turn' },
        { kind: 'turn', turnId: 'successor-turn', state: id === CUT ? 'running' : 'completed' },
        { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    if (id === DONE) {
      await sessions.get(id)!.journal.appendItem(
        { provider: 'claude', sessionId: `${id}-provider`, uuid: 'question' },
        {
          kind: 'question',
          question: 'which?',
          options: [],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        },
        { fence }
      )
    }
  }
  const held = [lifetime.residency.borrow(CUT), lifetime.residency.borrow(DONE)]
  await seedJournal(UNWRITTEN, 'completed')
  host.deps.journalDatabase.db
    .prepare('UPDATE journal_rows SET row_json = ? WHERE session_id = ? AND seq = 2')
    .run('{}', UNWRITTEN)
  for (const id of candidates) {
    await seedJournal(id, 'completed')
  }
  const h = createOrchestrationRpcHarness()
  const { db, runtime, ctx, activeRunId } = h.setup()
  vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
    terminals: [],
    totalCount: 0,
    truncated: false
  })
  const handles = [...candidates, CUT, DONE, UNWRITTEN].map((id) => {
    const handle = mintStructuredWorkerHandle()
    const paneKey = mintStructuredWorkerPaneKey(id)
    structuredWorkerIdentities.register({
      handle,
      sessionId: id,
      agent: 'claude',
      paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(id),
      worktreeId: LOCATION.workspaceId,
      hostScope: { kind: 'local', hostId: 'local' }
    })
    return {
      id,
      handle,
      dispatch: createRootDispatch(db, db.createTask({ spec: id, runId: activeRunId }).id, handle)
        .id
    }
  })
  const work = host.currentWork
  vi.spyOn(host, 'currentWork').mockImplementation((id) => {
    expect(lifetime.residency.borrowed(id)).toBe(true)
    return work(id)
  })
  const snapshot = host.journalSnapshot
  const status = runtime.getAgentStatusForHandle.bind(runtime)
  let classifying = false
  vi.spyOn(runtime, 'getAgentStatusForHandle').mockImplementation(async (handle) => {
    classifying = true
    try {
      return await status(handle)
    } finally {
      classifying = false
    }
  })
  let active = 0,
    peak = 0,
    reads = 0
  vi.spyOn(host, 'journalSnapshot').mockImplementation(async (id) => {
    const classification = classifying
    if (classification) {
      peak = Math.max(peak, ++active)
      reads++
      expect(candidates.filter(host.hasSession)).toHaveLength(0)
    }
    try {
      return await snapshot(id)
    } finally {
      if (classification) {
        active--
      }
    }
  })
  try {
    for (const count of [3, 30]) {
      for (const row of handles.slice(count, 30)) {
        db.completeDispatch(row.dispatch)
      }
      reads = 0
      await h.call(
        'orchestration.send',
        { from: 'term_coord', to: '@idle', subject: `select-${count}` },
        ctx
      )
      expect(reads).toBe(count + 3)
      expect(peak).toBe(1)
      for (const row of handles) {
        expect(db.getUnreadMessages(`dispatch:${row.dispatch}`).length, row.id).toBe(
          candidates.slice(0, count).includes(row.id) ? 1 : 0
        )
      }
      expect(candidates.some(host.hasSession)).toBe(false)
      if (count === 3) {
        for (const row of handles.slice(3, 30)) {
          db.db
            .prepare("UPDATE dispatch_contexts SET status = 'dispatched' WHERE id = ?")
            .run(row.dispatch)
        }
        db.db.prepare('DELETE FROM messages').run()
      }
    }
    const pointer = createStructuredMailboxPointerHost()
    expect(await pointer.readSessionFacts(candidates[0])).toBeNull()
    expect(db.getUnreadMessages(`dispatch:${handles[0].dispatch}`)).toHaveLength(1)
    await expect(host.withAutomaticConversation(CUT, async () => 'resident')).resolves.toBe(
      'resident'
    )
    const original = new Error('original action error')
    await expect(
      host.withAutomaticConversation(victims[0], async () => {
        throw original
      })
    ).rejects.toBe(original)
    held.forEach((release) => {
      release()
      release()
    })
    expect(lifetime.residency.borrowed(CUT)).toBe(false)
    expect(host.deps.store.transitionHandoff).toHaveBeenCalled()
  } finally {
    held.forEach((release) => release())
    h.cleanup()
  }
})

it('preserves waiting-card pause and failed-mark fallback across cache reacquisition', async () => {
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId: CUT,
      workspaceId: LOCATION.workspaceId,
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle(`${CUT}-provider`, null)
    },
    database: openTestJournalHostDatabase(root)
  })
  await journal.queuedMessages.insert({
    messageId: 'waiting',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'queued' }] }
  })
  await journal.close()
  const seen = new Map<string, AgentSessionJournal>()
  const open = AgentSessionJournal.prototype.open
  vi.spyOn(AgentSessionJournal.prototype, 'open').mockImplementation(async function () {
    await open.call(this)
    seen.set(this.snapshot().sessionId, this)
  })
  vi.spyOn(AgentSessionJournal.prototype, 'appendQueueReopen').mockRejectedValueOnce(
    new Error('disk full')
  )
  await host.journalSnapshot(CUT)
  const before = seen.get(CUT)!.queuedMessages.pauses()
  expect(before.map((pause) => pause.reason)).toContain('restarted')
  for (const id of [DONE, LEGACY_WORKING]) {
    await host.journalSnapshot(id)
  }
  await vi.waitFor(() => expect(host.hasSession(CUT)).toBe(false))
  await host.journalSnapshot(CUT)
  expect(seen.get(CUT)!.queuedMessages.pauses()).toEqual(before)
})

it('lists failures and names without opens, opens only an admitted selection, and dismisses without history', async () => {
  const capsule = host.deps.recoveryCapsule!
  const offer = (id: string) =>
    marker({
      sessionId: id,
      recordedAt: NOW,
      providerHandleRoot: agentSessionProviderHandleRoot(
        claudeProviderHandle(`${id}-provider`, null)
      )
    })
  await capsule.record([offer(CUT), offer(DONE), offer(LEGACY_WORKING)], NOW)
  await capsule.beginResume([LEGACY_WORKING], 'failed', NOW)
  await capsule.failResume(
    'failed',
    [
      {
        sessionId: LEGACY_WORKING,
        failedAt: NOW,
        reason: 'provider unavailable',
        outcome: 'refused',
        latestPrompt: '',
        latestUserItemId: null
      }
    ],
    NOW
  )
  const opened: string[] = []
  const original = AgentSessionJournal.prototype.open
  vi.spyOn(AgentSessionJournal.prototype, 'open').mockImplementation(async function () {
    await original.call(this)
    opened.push(this.snapshot().sessionId)
  })
  expect((await host.restartResume.list()).map((row) => row.conversationName)).toEqual([
    `name of ${CUT}`,
    `name of ${DONE}`
  ])
  expect(await host.restartResume.listFailures()).toMatchObject([
    { sessionId: LEGACY_WORKING, conversationName: `name of ${LEGACY_WORKING}` }
  ])
  expect(opened).toEqual([])
  await host.restartResume.continueAfterRestart([CUT], 'test')
  expect(opened).toEqual([CUT])
  opened.length = 0
  await host.restartResume.dismiss()
  expect(opened).toEqual([])
})

it('releases common construction at adoption while awaited actions retain their borrows', async () => {
  const { lifetime, conversationDelivery, sessions } = host.collaboratorsForTests()
  let finish!: () => void
  let adopted!: () => void
  const ready = new Promise<void>((resolve) => {
    adopted = resolve
  })
  const handover = new Promise<void>((resolve) => {
    finish = resolve
  })
  await host.journalSnapshot(NEVER_SENT)
  const open = vi.spyOn(AgentSessionJournal.prototype, 'open')
  installAcquisitionFixture()
  host.deps.adapter.dispatch = async (input) => {
    await input.beforeDispatch?.()
    adopted()
    await handover
    return {
      state: 'accepted',
      providerIdentity: {
        provider: 'claude',
        sessionId: `${CUT}-provider`,
        uuid: 'accepted-send'
      }
    }
  }
  const acquisition = vi.spyOn(conversationDelivery, 'open')
  const action = host.withAutomaticConversation(CUT, () =>
    sendAgentTurn({
      kind: 'structured-session',
      host,
      sessionId: CUT,
      callerKey: 'trusted-local:orchestration:test',
      turn: {
        delivery: 'now',
        operationId: `${NOW}-${'1'.repeat(32)}`,
        expectedRuntimeFence: host.deps.store.getRecord(CUT)!.lease.runtimeFence,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'continue' }] }
      }
    })
  )
  try {
    await Promise.race([
      ready,
      action.then((result) => {
        throw new Error(JSON.stringify(result))
      })
    ])
    const second = host.withAutomaticConversation(DONE, () => host.journalSnapshot(DONE))
    await expect(second).resolves.toMatchObject({ sessionId: DONE })
    await expect(host.withAutomaticConversation(NEVER_SENT, async () => 'resident')).resolves.toBe(
      'resident'
    )
    expect(lifetime.residency.borrowed(CUT)).toBe(true)
    expect(open).toHaveBeenCalledTimes(2)
    lifetime.residency.closed(CUT, true, { epoch: 'old', sequence: 1 })
    const session = sessions.get(CUT)!
    await conversationDelivery.adoptOpened(CUT, { session })
    expect(lifetime.residency.cacheReacquisition(CUT)).toBeUndefined()
  } finally {
    finish()
  }
  await expect(action).resolves.toMatchObject({
    kind: 'sent',
    submission: { dispatchState: 'accepted' }
  })
  expect(acquisition).toHaveBeenCalledWith(CUT, { acquisition: true })
  await lifetime.residency.trim()
})

it('does no unrelated history walk on real no-pressure release at N and 10N active residents', async () => {
  const { lifetime, sessions, serialize } = host.collaboratorsForTests()
  await host.journalSnapshot(CUT)
  const original = sessions.get(CUT)!
  const releases: (() => void)[] = []
  for (const count of [30, 300]) {
    for (let index = sessions.size; index < count; index++) {
      const id = `active-${index}`
      sessions.set(id, { ...original })
      releases.push(lifetime.residency.borrow(id))
    }
    expect(original.journal.submissions().length).toBeGreaterThan(0)
    await serialize(CUT, async () => {})
    await Promise.resolve()
    const histories = vi.spyOn(original.journal, 'submissions')
    const population = vi.spyOn(sessions, Symbol.iterator)
    for (let index = 0; index < 10; index++) {
      await serialize(CUT, async () => {})
    }
    await Promise.resolve()
    expect(histories).not.toHaveBeenCalled()
    expect(population).not.toHaveBeenCalled()
    histories.mockRestore()
    population.mockRestore()
  }
  for (const release of releases) {
    release()
  }
  await lifetime.residency.trim()
})
