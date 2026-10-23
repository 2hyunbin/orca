import { sendAgentTurn } from '../../runtime/orchestration/send-agent-turn'
import { agentSessionProviderHandleRoot } from '../../../shared/agent-session-provider-handle-encoding'
// A relaunched host lists every restored chat as Interrupted or Done and reads none of their
// history: each row comes from the chat's record, its journal's saved open turn and the offers the
// last quit recorded. Opening a chat is what reads it.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { structuredAgentSessionHostInstance } from './structured-agent-session-queued-pause'
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
/** Saved before journals kept an open turn: the quit's offer is what says it was working. */
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
      { kind: 'turn', turnId: 'turn-1', state: turn, startedAt: NOW },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  await journal.close()
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
  vi.restoreAllMocks()
  await host.flushAllStreamedEvents()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
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
  // Each row's state, verdict and saved name, as the sidebar and the agent-status store read them.
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

it('reads a chat when it is opened, and keeps only the resident cap of opened chats', async () => {
  await host.restoreReadableSessions([CUT, DONE, LEGACY_WORKING])

  for (const sessionId of [CUT, DONE, LEGACY_WORKING]) {
    await host.journalSnapshot(sessionId)
  }

  // The first opened is the least recently active: it closes, and keeps its journal's own row.
  await vi.waitFor(() => expect(host.hasSession(CUT)).toBe(false))
  expect([DONE, LEGACY_WORKING].every(host.hasSession)).toBe(true)
  expect(host.readStatusSummary(CUT)).toMatchObject({
    status: 'idle',
    turnOutcome: 'cancellation',
    latestPrompt: `ask ${CUT}`
  })
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
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'queued' }] },
    fingerprint: 'fp',
    hostInstance: structuredAgentSessionHostInstance()
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
    // All adoption routes clear the failed-reopen floor, including acquisition's direct open.
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
    // These are settled submissions in a real opened canonical journal, not a Set of ids.
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
