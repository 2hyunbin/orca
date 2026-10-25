vi.mock('../agent-session-journal/journal-legacy-rest-worker', async () => {
  const { InProcessLegacyRestWorker } =
    await import('../agent-session-journal/journal-legacy-rest-replay-test-support')
  return { JournalLegacyRestWorker: InProcessLegacyRestWorker }
})

// Only user-close supplies personal cancellation; host eviction/quit leaves interrupted work reportable.
// Provider and fallback turn-end writers both derive verdict from the journal Stop event.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { describeNativeChatTurnStatus } from '../../../shared/native-chat-turn-status'
import { withNativeChatCutTurnNotices } from '../../../shared/native-chat-cut-turn-notice'
import { selectStructuredAgentSettledTurns } from '../../../shared/structured-agent-session-turn-timing'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { JournalLegacyRestInitializer } from '../agent-session-journal/journal-legacy-rest-initializer'
import { setStructuredJournalReadiness } from './structured-agent-session-registry'
import {
  adapter,
  attach,
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { structuredAgentSessionAgentStatus } from '../../../shared/structured-agent-session-agent-status'
import { agentTurnEligibleForAttention } from '../../../shared/agent-main-agent-verdict'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const CUT_TURN = { provider: 'codex' as const, threadId: THREAD, turnId: 'cut-turn', ordinal: 1 }

let host: StructuredAgentSessionHost
/** Simulate adapter turn-end mapping, explicit verdicts, or no provider row. */
let providerEnd:
  | 'mapped'
  | Pick<AgentJournalTurnLifecycle, 'state' | 'outcome' | 'completedAt'>
  | null
let exitObservedFirst: boolean
let closeCalls = 0

beforeEach(() => {
  const state = hostTestState()
  providerEnd = 'mapped'
  exitObservedFirst = false
  closeCalls = 0
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store: state.store,
    adapter: {
      ...adapter(),
      closeSession: async () => {
        closeCalls += 1
        const events = state.acquire.mock.calls.at(-1)?.[0].events
        if (providerEnd === null) {
          return true
        }
        // Compare provider-observed exit against the close’s Stop timestamp.
        const end =
          providerEnd === 'mapped'
            ? { state: 'interrupted' as const, completedAt: exitObservedFirst ? 1_500 : Date.now() }
            : providerEnd
        events?.appendItem(
          CUT_TURN,
          {
            kind: 'turn',
            turnId: 'cut-turn',
            startedAt: 1_000,
            requestedAt: 1_000,
            ...end
          },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        return true
      }
    },
    journalDatabase: openTestJournalHostDatabase(state.root),
    recoveryCapsule: new AgentSessionRecoveryCapsule(state.root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => HOST_TEST_NOW
  })
  replaceHostTestState({ store: state.store, host })
})

async function runningTurn(): Promise<AgentSessionStatusEvent[]> {
  await attach()
  const events = hostTestState().acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing provider event sink')
  }
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'cut-turn', ordinal: 0 },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'long job' }] },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  events.appendItem(
    CUT_TURN,
    {
      kind: 'turn',
      turnId: 'cut-turn',
      state: 'running',
      startedAt: 1_000,
      requestedAt: 1_000
    },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await host.flushStreamedEvents(SESSION)
  const statuses: AgentSessionStatusEvent[] = []
  host.subscribeStatus({ id: 'list', emit: (event) => statuses.push(event) })
  return statuses
}

/** The next Orca over the files a quit left: the one that reads them, since startup opens none. */
function relaunch(): void {
  const { store, root } = hostTestState()
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: adapter(),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-b',
    now: () => HOST_TEST_NOW
  })
  replaceHostTestState({ store, host })
}

/** What the settle wrote, read back from the journal the next reader opens. */
async function settledTurn() {
  await host.restoreReadableSessions([SESSION])
  const { items } = await host.journalSnapshot(SESSION)
  const turn = items.map((item) => readAgentJournalTurn(item.body)).find(Boolean)
  const [settled] = [...selectStructuredAgentSettledTurns(items).values()]
  const label = settled && describeNativeChatTurnStatus({ elapsedSeconds: 0, ...settled }).key
  const notices = withNativeChatCutTurnNotices(items, { agentName: 'Codex' }).flatMap((item) =>
    item.body.kind === 'status' && item.body.tone === 'error' ? [item.body.text] : []
  )
  return { turn, settled, label, notices }
}

const ONE_NOTICE = [
  'Codex stopped while this response was in progress. You can continue in this conversation.'
]

function lastSummary(statuses: AgentSessionStatusEvent[]) {
  const last = statuses.at(-1)
  return last?.type === 'status' ? last.session : null
}

function attention(row: AgentSessionStatusSummary | null | undefined): boolean {
  if (!row || row.status === null) {
    throw new Error('missing status for attention consumer')
  }
  return agentTurnEligibleForAttention({
    ...row,
    ...structuredAgentSessionAgentStatus({ ...row, status: row.status })
  })
}

describe('a turn cut short by closing its provider', () => {
  it('keeps current Stop low priority through release and cache reacquisition, then restores it at its saved clock', async () => {
    const trusted: AgentSessionStatusSummary[] = []
    host.deps.statusSink = { publish: (row) => trusted.push(row), forget: () => {} }
    const statuses = await runningTurn()
    hostTestState().cancelTurn.mockImplementationOnce(async () => {
      hostTestState().acquire.mock.calls[0]?.[0].events?.appendItem(
        CUT_TURN,
        {
          kind: 'turn',
          turnId: 'cut-turn',
          state: 'interrupted',
          startedAt: 1000,
          completedAt: HOST_TEST_NOW
        },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      return { cancelled: true }
    })
    const stopped = await host.cancel(CALLER, {
      envelope: envelope('agentSession.cancel', { turnId: 'cut-turn' }),
      turnId: 'cut-turn'
    })
    expect(stopped).toMatchObject({ ok: true, value: { cancelled: true } })
    await host.flushStreamedEvents(SESSION)
    providerEnd = null
    await host.close(SESSION, 'evict')
    expect(hostTestState().store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    await host.journalSnapshot(SESSION)
    const beforeBackground = { trusted: [...trusted], statuses: [...statuses] }
    const advance = vi.spyOn(JournalLegacyRestInitializer.prototype, 'advance')
    setStructuredJournalReadiness(() => true)
    try {
      host.advanceLegacyRest()
      await advance.mock.results.findLast((result) => result.value)?.value
    } finally {
      setStructuredJournalReadiness(() => false)
    }
    expect({ trusted, statuses }).toEqual(beforeBackground)
    for (const row of [trusted.at(-1), lastSummary(statuses)]) {
      expect(row).toMatchObject({
        status: 'idle',
        turnOutcome: 'cancellation',
        statusStartedAt: HOST_TEST_NOW
      })
      expect(row?.restoredInterruption).toBeUndefined()
      expect(attention(row)).toBe(false)
    }
    await host.flushAllStreamedEvents()
    const store = await openTestAgentSessionRecordStore(hostTestState().root)
    host = new StructuredAgentSessionHost({
      agents: NO_STRUCTURED_AGENTS,
      logger: createStructuredAgentSessionLogger(),
      store,
      adapter: adapter(),
      journalDatabase: openTestJournalHostDatabase(hostTestState().root),
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-restart',
      now: () => HOST_TEST_NOW,
      statusSink: { publish: (row) => trusted.push(row), forget: () => {} }
    })
    replaceHostTestState({ store, host })
    const restored: AgentSessionStatusEvent[] = []
    host.subscribeStatus({ id: 'restart-both', emit: (event) => restored.push(event) })
    await host.restoreReadableSessions([SESSION])
    await host.journalSnapshot(SESSION)
    for (const row of [trusted.at(-1), lastSummary(restored)]) {
      expect(row).toMatchObject({
        status: 'idle',
        turnOutcome: 'cancellation',
        restoredInterruption: true,
        statusStartedAt: 1000
      })
      expect(attention(row)).toBe(true)
    }
  })

  it("records the user's close of this chat as their cancellation", async () => {
    const statuses = await runningTurn()

    await host.close(SESSION, 'user-close')

    expect(lastSummary(statuses)).toMatchObject({ status: 'idle', turnOutcome: 'cancellation' })
    const { turn, label, notices } = await settledTurn()
    expect(turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(label).toBe('interruptedAfter')
    expect(notices).toEqual([])
  })

  it('leaves a close the user did not aim at this chat as news', async () => {
    const statuses = await runningTurn()

    await host.close(SESSION, 'evict')

    expect(lastSummary(statuses)).toMatchObject({ status: 'idle', turnOutcome: 'interruption' })
    const { turn, label, notices } = await settledTurn()
    expect(turn).toMatchObject({ state: 'interrupted' })
    expect(turn).not.toHaveProperty('outcome')
    expect(label).toBe('workedFor')
    expect(notices).toEqual(ONE_NOTICE)
  })

  it("records the user's close on a turn no adapter settled, through the host's fallback", async () => {
    providerEnd = null
    const statuses = await runningTurn()

    await host.close(SESSION, 'user-close')

    expect(lastSummary(statuses)).toMatchObject({ status: 'idle', turnOutcome: 'cancellation' })
    const { turn } = await settledTurn()
    expect(turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  })

  it("records the user's close on a turn whose start landed only as the provider stopped", async () => {
    // Buffer turn-open in the sink so close starts before the journal sees it.
    await attach()
    await host.flushStreamedEvents(SESSION)
    const events = hostTestState().acquire.mock.calls[0]?.[0].events
    events?.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'cut-turn', ordinal: 0 },
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'long job' }] },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    events?.appendItem(
      CUT_TURN,
      { kind: 'turn', turnId: 'cut-turn', state: 'running', startedAt: 1_000, requestedAt: 1_000 },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )

    await host.close(SESSION, 'user-close')

    const { turn } = await settledTurn()
    expect(turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  })

  it('leaves a turn cut off before the close as news', async () => {
    providerEnd = null
    await attach()
    const events = hostTestState().acquire.mock.calls[0]?.[0].events
    events?.appendItem(
      CUT_TURN,
      {
        kind: 'turn',
        turnId: 'cut-turn',
        state: 'interrupted',
        startedAt: 1_000,
        requestedAt: 1_000,
        completedAt: 1_200
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await host.flushStreamedEvents(SESSION)

    await host.close(SESSION, 'user-close')

    const { turn } = await settledTurn()
    expect(turn).toMatchObject({ state: 'interrupted', completedAt: 1_200 })
    expect(turn).not.toHaveProperty('outcome')
  })

  it('keeps a turn the provider finished during the stop as finished', async () => {
    providerEnd = { state: 'completed', outcome: 'success', completedAt: 1_500 }
    await runningTurn()

    await host.close(SESSION, 'user-close')

    const { turn } = await settledTurn()
    expect(turn).toMatchObject({ state: 'completed', outcome: 'success' })
  })

  it('keeps a verdict the provider gave on its way out', async () => {
    providerEnd = { state: 'interrupted', outcome: 'failure', completedAt: 1_500 }
    await runningTurn()

    await host.close(SESSION, 'user-close')

    const { turn } = await settledTurn()
    expect(turn).toMatchObject({ state: 'interrupted', outcome: 'failure' })
  })

  it('leaves a quit as news', async () => {
    const statuses = await runningTurn()

    await host.flushAllStreamedEvents({ trigger: 'quit' })
    relaunch()

    expect(statuses.findLast((event) => event.type === 'status')).toMatchObject({
      session: { status: 'idle', turnOutcome: 'interruption' }
    })
    const { label, notices } = await settledTurn()
    expect(label).toBe('workedFor')
    expect(notices).toEqual(ONE_NOTICE)
  })

  it("keeps the user's cancellation when a close's drain fails after the provider settled", async () => {
    await runningTurn()
    const sink = host['runtimeState'].eventSinkFor(SESSION)
    const drained = sink.drained.bind(sink)
    let failed = false
    vi.spyOn(sink, 'drained').mockImplementation(async () => {
      if (closeCalls > 0 && !failed) {
        failed = true
        return { ok: false, error: new Error('drain failed') }
      }
      return drained()
    })
    await expect(host.close(SESSION, 'user-close')).resolves.toBeUndefined()
    expect(closeCalls).toBe(1)
    const { turn } = await settledTurn()
    expect(turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  })

  it.each([
    ['user-close', { outcome: 'cancellation' }],
    ['evict', { outcome: undefined }]
  ] as const)(
    "keeps a %s's cause when the close's drain fails before the host settles its turn",
    async (cause, verdict) => {
      providerEnd = null
      await runningTurn()
      const sink = host['runtimeState'].eventSinkFor(SESSION)
      const drained = sink.drained.bind(sink)
      let failed = false
      vi.spyOn(sink, 'drained').mockImplementation(async () => {
        if (closeCalls > 0 && !failed) {
          failed = true
          return { ok: false, error: new Error('drain failed') }
        }
        return drained()
      })
      await expect(host.close(SESSION, cause)).resolves.toBeUndefined()

      expect(closeCalls).toBe(1)
      const { turn, notices } = await settledTurn()
      expect(turn).toMatchObject({ state: 'interrupted' })
      expect(turn?.outcome).toBe(verdict.outcome)
      expect(notices).toEqual(cause === 'evict' ? ONE_NOTICE : [])
    }
  )

  it("leaves a quit's cut on a turn no adapter settled as news", async () => {
    providerEnd = null
    await runningTurn()

    await host.flushAllStreamedEvents({ trigger: 'quit' })
    relaunch()

    const { turn, notices } = await settledTurn()
    expect(turn).toMatchObject({ state: 'interrupted' })
    expect(turn).not.toHaveProperty('outcome')
    expect(notices).toEqual(ONE_NOTICE)
  })

  it('leaves a crash the provider saw before the user closed the chat as news', async () => {
    exitObservedFirst = true
    await runningTurn()
    await host.close(SESSION, 'user-close')
    const { turn, notices } = await settledTurn()
    expect(turn).toMatchObject({ state: 'interrupted' })
    expect(turn).not.toHaveProperty('outcome')
    expect(notices).toEqual(ONE_NOTICE)
  })

  it.each(['user-close', 'evict'] as const)(
    'closes the conversation of a chat a %s ends, as any close does',
    async (cause) => {
      await runningTurn()

      await host.close(SESSION, cause)

      expect(host.hasSession(SESSION)).toBe(false)
    }
  )
})
