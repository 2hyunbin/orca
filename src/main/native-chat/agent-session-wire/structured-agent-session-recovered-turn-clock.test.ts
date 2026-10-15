import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
// A turn that was running when its host went away ends when recovery settles it. That settlement is
// the edge the user needs to see — their work stopped — so the session reads as newly done then,
// with what the host observed of the end as its verdict, and nothing along the way may call it a
// success. Every hop is the real one: durable journal, recovery settlement, status feed, the host's
// status row, and the turn-completion feed.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentSessionStatusSummary,
  AgentSessionTurnCompletionEvent
} from '../../../shared/agent-session-wire'
import {
  agentTurnEndedOnPurpose,
  agentVerdictDisplayMark
} from '../../../shared/agent-main-agent-verdict'
import { AgentHookServer, _internals } from '../../agent-hooks/server'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  settleStaleStructuredAgentSessionState,
  settleStructuredAgentSessionDeadGeneration
} from './structured-agent-session-dead-generation-settlement'
import type { StructuredAgentSessionTurnVerdict } from './structured-agent-session-stale-turn-verdict'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import { indexedStatusFeedSession } from './structured-agent-session-status-feed-test-session'
import { StructuredAgentSessionTurnCompletionFeed } from './structured-agent-session-turn-completion-feed'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { settleStructuredAgentSessionChildExit } from './structured-agent-session-child-exit'
import type { AgentJournalTurnLifecycle } from '../../../shared/agent-session-journal-types'

const SESSION = 'recovered-turn-session'
const THREAD = 'thread-1'
const TURN_STARTED = 1_000
const EXIT_OBSERVED = 2_000
const RECOVERED = 9_000
const RESTORED = { state: 'completed', outcome: 'success', completedAt: EXIT_OBSERVED } as const

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  _internals.resetCachesForTests()
  root = await mkdtemp(join(tmpdir(), 'orca-recovered-turn-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

/** A session whose turn was running when its host went away, reopened by the next host. */
async function sessionWithRunningTurn() {
  let clock = TURN_STARTED
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle(THREAD)
    },
    now: () => clock,
    stateDirectory: join(root, SESSION)
  })
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'prompt-1' },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'long job' }] },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  const server = new AgentHookServer()
  const sessions = new Map([[SESSION, indexedStatusFeedSession({ journal })]])
  const feed = new StructuredAgentSessionStatusFeed({
    logger: createStructuredAgentSessionLogger(),
    sessions,
    getRecord: () => null,
    now: () => clock,
    statusSink: () => ({
      publish: (summary, subject) => server.ingestStructuredStatus(summary, subject),
      forget: (subject) => server.dropStructuredStatus(subject)
    })
  })
  const summaries: AgentSessionStatusSummary[] = []
  feed.subscribe({
    id: 'list-1',
    emit: (event) => {
      if (event.type === 'snapshot') {
        summaries.push(...event.sessions)
      } else if (event.type === 'status') {
        summaries.push(event.session)
      }
    }
  })
  const completions = new StructuredAgentSessionTurnCompletionFeed({
    sessions,
    now: () => clock,
    readStatusState: (sessionId, source) => feed.journalProjection(sessionId, source)?.state ?? null
  })
  const completionEvents: AgentSessionTurnCompletionEvent[] = []
  completions.subscribe({ id: 'dot-1', emit: (event) => completionEvents.push(event) })
  // Both feeds have seen the turn running, so its settlement is a transition they must judge.
  completions.observe(SESSION, journal)
  const publish = (): void => {
    feed.publish(SESSION, journal)
    completions.observe(SESSION, journal)
  }
  const writeTurn = async (turn: Omit<AgentJournalTurnLifecycle, 'turnId'>, fence = 1) => {
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 9 },
      { kind: 'turn', turnId: 'turn-1', startedAt: TURN_STARTED, ...turn },
      { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    publish()
  }
  await writeTurn({ state: 'running' })
  return {
    journal,
    server,
    summaries,
    completionEvents,
    publish,
    writeTurn,
    reopen: () => completions.observe(SESSION, journal, { historical: true }),
    recoverAt: (at: number) => {
      clock = at
    }
  }
}

function settleDeadGeneration(
  journal: AgentSessionJournal,
  verdict: StructuredAgentSessionTurnVerdict
): ReturnType<typeof settleStructuredAgentSessionDeadGeneration> {
  return settleStructuredAgentSessionDeadGeneration({
    journal,
    sessionId: SESSION,
    fence: 2,
    settlementId: 'settle-1',
    verdict,
    pendingSubmissionReason: 'provider_exited_before_acknowledgement'
  })
}

describe('a turn recovery settled after its host went away', () => {
  it.each([
    ['an unverifiable end', { state: 'unverifiable' } as const, 'unconfirmed', 'unconfirmed'],
    [
      'an exit observed before the restart',
      { state: 'interrupted', completedAt: EXIT_OBSERVED },
      'interruption',
      'interrupted'
    ]
  ] satisfies [
    string,
    StructuredAgentSessionTurnVerdict,
    'unconfirmed' | 'interruption',
    'unconfirmed' | 'interrupted'
  ][])(
    'is done as of the recovery with the end the host observed, never a success: %s',
    async (_label, verdict, outcome, mark) => {
      const session = await sessionWithRunningTurn()
      session.recoverAt(RECOVERED)
      session.reopen()
      expect(await settleDeadGeneration(session.journal, verdict)).toEqual({ ok: true })
      session.publish()

      expect(session.summaries.at(-1)).toMatchObject({
        status: 'idle',
        statusStartedAt: RECOVERED,
        turnOutcome: outcome
      })
      const [row] = session.server.getStatusSnapshot()
      // A done row dated at the recovery is a completion the user has not read yet.
      expect(row).toMatchObject({
        state: 'done',
        stateStartedAt: RECOVERED,
        mainAgent: { state: 'done', outcome, stateStartedAt: RECOVERED }
      })
      // Nobody stopped it: the flag older readers take as a user's stop stays down.
      expect(row?.interrupted ?? false).toBe(false)
      // The sidebar and tab read the published row, with no user action in between.
      expect(row && agentVerdictDisplayMark(row)).toBe(mark)
      expect(row && agentTurnEndedOnPurpose(row)).toBe(false)
      // The dot and the OS notification come only from a completion event, and none is sent.
      await session.writeTurn(RESTORED, 2)
      expect(session.completionEvents).toEqual([])
    }
  )

  it('is dated the same way when a new provider child finds the turn still running', async () => {
    const session = await sessionWithRunningTurn()
    session.recoverAt(RECOVERED)
    await settleStaleStructuredAgentSessionState({
      journal: session.journal,
      sessionId: SESSION,
      fence: 2,
      acquisitionGeneration: 'generation-2',
      deathEvidence: null
    })
    session.publish()

    expect(session.summaries.at(-1)).toMatchObject({
      status: 'idle',
      statusStartedAt: RECOVERED,
      // No evidence of the old owner's death: the end cannot be proven.
      turnOutcome: 'unconfirmed'
    })
    const [row] = session.server.getStatusSnapshot()
    expect(row).toMatchObject({
      state: 'done',
      stateStartedAt: RECOVERED,
      mainAgent: { state: 'done', outcome: 'unconfirmed' }
    })
    expect(row && agentVerdictDisplayMark(row)).toBe('unconfirmed')
    expect(session.completionEvents).toEqual([])
  })

  // The control that keeps the silence above from being vacuous: a turn its provider finished does
  // reach the completion feed through this same harness, dated by its own end.
  it('leaves a turn its provider finished to the provider, dated by its own end', async () => {
    const session = await sessionWithRunningTurn()
    session.recoverAt(RECOVERED)
    await session.journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 9 },
      {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'completed',
        outcome: 'success',
        startedAt: TURN_STARTED,
        completedAt: EXIT_OBSERVED
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    session.publish()

    expect(session.summaries.at(-1)).toMatchObject({
      status: 'idle',
      statusStartedAt: EXIT_OBSERVED,
      turnOutcome: 'success'
    })
    expect(session.completionEvents).toEqual([
      expect.objectContaining({
        type: 'completion',
        completion: expect.objectContaining({ outcome: 'success' })
      })
    ])
  })
})

describe('a turn whose provider exited on its own', () => {
  it.each([
    ['fails, announced once as any failure', false, undefined, 'failed', ['failure']],
    ["stays a person's earlier Stop", true, undefined, 'interrupted', ['cancellation']],
    ['stays interrupted when Orca cut it', false, { kind: 'hostFault' }, 'interrupted', []]
  ] as const)('%s', async (_label, stopFirst, failure, mark, announced) => {
    const session = await sessionWithRunningTurn()
    if (stopFirst) {
      await session.journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn-1' }, 1)
    }
    const record = agentSessionRecordFixture(agentSessionLeaseFixture())
    const child = { generation: 'gen-1', fence: 1, phase: 'ready' as const }
    await settleStructuredAgentSessionChildExit(
      {
        logger: createStructuredAgentSessionLogger(),
        store: { getRecord: () => record, transitionHandoff: async () => record },
        sessions: new Map([[SESSION, { child, journal: session.journal }]]),
        // The adapter's own outcome-less end lands and is published before the host settles.
        flushLifecycle: async () => {
          await session.writeTurn({ state: 'interrupted', completedAt: EXIT_OBSERVED })
          return { ok: true }
        },
        publishFence: () => {},
        serialize: async (_sessionId, task) => task(),
        now: () => EXIT_OBSERVED
      },
      {
        type: 'ended',
        sessionId: SESSION,
        reason: 'exited',
        cause: 'unexpected-exit',
        fence: 1,
        acquisitionGeneration: 'gen-1',
        ...(failure ? { failure } : {})
      }
    )
    session.publish()

    expect(agentVerdictDisplayMark(session.server.getStatusSnapshot()[0]!)).toBe(mark)
    expect(session.completionEvents).toMatchObject(
      announced.map((outcome) => ({ completion: { outcome } }))
    )
  })
})
