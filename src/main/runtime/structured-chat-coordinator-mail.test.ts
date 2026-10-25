import './rpc/unused-default-rpc-methods.test-fixture'
// A worker's result reaching the structured chat that coordinates it, end to end in one process,
// on the coordinator-mail rig.

vi.mock('../node-runtime/pinned-zip-members', () => ({
  extractPinnedZipMembers: () => {
    throw new Error('Mail fixtures must not install a runtime')
  }
}))

import { describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import {
  AgentSessionAcquisitionRefusal,
  AgentSessionPreSpawnError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS } from '../../shared/agent-session-host-authority'
import { refuse } from '../../shared/agent-session-wire-refusals'
import { readMailHandoff } from './orchestration/mail-handoff'
import { currentRunCoordinatorOrcaSessionId } from './orchestration/db/runs/run-coordinator-orca-session'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import { operationId, providerFaults } from './structured-chat-coordinator-fake-codex-fixture'

import {
  COORDINATOR,
  PEER_CHAT,
  WORKER_2_PANE,
  codex,
  runtime,
  db,
  host,
  dispatcher,
  observationClock,
  request,
  call,
  openChat,
  connectionFor,
  settleTurn,
  sendUserMessage,
  userTexts,
  finishWorker,
  coordinatorRunAndTask,
  clearChat,
  startClearedContext,
  WAIT,
  MAIL,
  turnText,
  queuedCardTexts,
  restartHostAndRuntime
} from './structured-chat-coordinator-mail-rig.test-fixture'

const edgesAnswered = (): Promise<void> => observationClock.edgesAnswered(runtime, WAIT)

describe('a worker result reaches the structured chat that coordinates it', () => {
  it('lands as a turn in the coordinator journal, and a flagless check returns the worker_done', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()

    await finishWorker(taskId)

    // No user action: the result itself sends the chat a turn through the host's send.
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    expect(turnText(chat.turns[0]!)).toMatch(MAIL)
    await settleTurn(COORDINATOR, 0)
    expect(await userTexts(COORDINATOR)).toEqual([expect.stringMatching(MAIL)])

    const checked = await call('orchestration.check', {}, { sessionId: COORDINATOR })
    expect(checked).toMatchObject({
      runId,
      count: 1,
      messages: [{ type: 'worker_done', from_handle: 'term_worker' }]
    })
  })

  it('does not send a second pointer when the delivery is retried', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    await finishWorker(taskId)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)

    // A pending send is not an acknowledgement, so the mail is retained and retried on every edge
    // until the host confirms it: before the echo, and again at the turn's idle edge.
    runtime.deliverPendingMessagesForHandle(`run:${runId}`)
    await settleTurn(COORDINATOR, 0)
    runtime.deliverPendingMessagesForHandle(`run:${runId}`)
    await vi.waitFor(
      () =>
        expect(
          db.getUnreadMessages(`run:${runId}`).filter((message) => message.delivered_at === null)
        ).toEqual([]),
      WAIT
    )
    expect(chat.turns).toHaveLength(1)
    expect(await userTexts(COORDINATOR)).toHaveLength(1)
  })

  /** The operation ids the coordinator's journal recorded for its pointer turns. */
  async function mailSends(): Promise<string[]> {
    const snapshot = await host.journalSnapshot(COORDINATOR)
    return snapshot.submissions
      .filter((submission) =>
        snapshot.items.some(
          (item) =>
            item.itemId === agentJournalSubmissionKey(submission.clientMessageId) &&
            item.body?.kind === 'message' &&
            item.body.blocks.some((block) => block.type === 'text' && MAIL.test(block.text))
        )
      )
      .map((submission) => submission.clientMessageId)
  }

  it('keeps unconfirmed input readable after provider death without attributing it to a later person turn', async () => {
    // A provider that dies before echoing never ran the pointer: the mail stays unpointed, and
    // neither the death's own edge nor an idle one starts the provider again for it.
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    await finishWorker(taskId)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)

    chat.handlers.onExit?.(new Error('provider died before the echo'))
    const before = codex.connections.length
    await edgesAnswered()
    await edgesAnswered()
    expect(codex.connections.length).toBe(before)
    expect(db.getUnreadMessages(`run:${runId}`)).toHaveLength(1)

    // The user's next message starts the agent; once its turn runs, the pointer follows it.
    expect(await sendUserMessage(COORDINATOR, 'again')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(codex.connections.length).toBe(before + 1), WAIT)
    const revived = connectionFor(COORDINATOR)
    await vi.waitFor(() => expect(revived.turns).toHaveLength(1), WAIT)
    expect(revived.turns[0]!.text).toContain('again')
    await settleTurn(COORDINATOR, 0)
    await edgesAnswered()
    expect(revived.turns).toHaveLength(1)
    expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
      count: 1
    })
  })

  it('does not restart a provider that dies before every echo, however many edges follow', async () => {
    observationClock.start()
    // What this pins: each death's own status edge used to re-point the mail, and that send started
    // the provider again, about once a second for as long as the mail was unread.
    await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    providerFaults.dieBeforeEveryEcho = true
    const before = codex.connections.length
    await finishWorker(taskId)
    await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(1), WAIT)
    // A fixed window, not a poll: a respawn loop would restart it several times in it.
    await observationClock.observe(1_500)
    await edgesAnswered()
    expect(codex.connections.length - before).toBe(0)
    expect(providerFaults.turnStarts).toBe(1)
    expect(db.getUnreadMessages(`run:${runId}`)).toHaveLength(1)
  })

  it.each(['exit-then-throw', 'throw-then-exit'] as const)(
    'does not restart a provider that crashed while taking the pointer turn (%s)',
    async (crash) => {
      observationClock.start()
      // The crash settles the send `unknown` with the connection's own error, not as a provider
      // exit; every status edge after it re-pointed the mail and started the provider again.
      await openChat(COORDINATOR)
      const { runId, taskId } = await coordinatorRunAndTask()
      providerFaults.crashOnTurnStart = crash
      const before = providerFaults.starts
      await finishWorker(taskId)
      await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(1), WAIT)
      await observationClock.observe(1_500)
      await edgesAnswered()
      expect(providerFaults.starts - before).toBe(0)
      expect(providerFaults.turnStarts).toBe(1)
      expect(await mailSends()).toHaveLength(1)
      expect(db.getUnreadMessages(`run:${runId}`)).toHaveLength(1)
    }
  )

  it('wakes for the next result after transient death and keeps uncertain older mail readable', async () => {
    await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    const second = await call(
      'orchestration.taskCreate',
      { spec: 'more' },
      { sessionId: COORDINATOR }
    )
    providerFaults.dieBeforeEveryEcho = true
    await finishWorker(taskId)
    await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(1), WAIT)
    await edgesAnswered()
    // The death was transient. A new result is new mail: one pointer for both, one start.
    providerFaults.dieBeforeEveryEcho = false
    const before = providerFaults.starts
    await finishWorker(idOf(second.task), { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
    await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(2), WAIT)
    const revived = connectionFor(COORDINATOR)
    expect(turnText(revived.turns.at(-1)!)).toMatch(MAIL)
    await settleTurn(COORDINATOR, revived.turns.length - 1)
    expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
      count: 2
    })
    expect(providerFaults.starts - before).toBe(1)
    expect(providerFaults.turnStarts).toBe(2)
  })

  it('leaves a pointer the person stopped while its agent was starting stopped', async () => {
    observationClock.start()
    await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    await host.close(COORDINATOR, 'evict')
    providerFaults.startDelayMs = 400
    const before = providerFaults.starts
    await finishWorker(taskId)
    await vi.waitFor(() => expect(providerFaults.starts).toBe(before + 1), WAIT)
    // The person presses Stop while the agent is still starting.
    const cancelling = host.cancel(
      { callerKey: 'test-surface' },
      {
        envelope: {
          sessionId: COORDINATOR,
          clientOperationId: operationId(),
          expectedRuntimeFence: host.deps.store.getRecord(COORDINATOR)!.lease.runtimeFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.cancel',
            sessionId: COORDINATOR,
            fields: { turnId: 'turn-x' }
          })
        },
        turnId: 'turn-x'
      }
    )
    await observationClock.observe(400)
    const cancelled = await cancelling
    expect(cancelled).toMatchObject({ ok: true })
    providerFaults.startDelayMs = 0
    // A fixed window, not a poll: a re-point would start the agent again in it.
    await observationClock.observe(1_500)
    expect(providerFaults.starts - before).toBe(1)
    expect(await mailSends()).toHaveLength(1)
    await edgesAnswered()
    expect(providerFaults.starts - before).toBe(1)
    expect(providerFaults.turnStarts).toBe(0)
    expect(db.getUnreadMessages(`run:${runId}`)).toHaveLength(1)
  })

  it('retries definitively unadmitted mail once in a new host incarnation, preserving its authorization', async () => {
    observationClock.start()
    await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    await host.close(COORDINATOR, 'evict')
    providerFaults.refuseStart = () => new AgentSessionAcquisitionRefusal('no login', 'notSignedIn')
    await finishWorker(taskId)
    await vi.waitFor(
      async () =>
        expect((await host.journalSnapshot(COORDINATOR)).submissions[0]?.dispatchState).toBe(
          'rejected'
        ),
      WAIT
    )
    const held = readMailHandoff(db.getUnreadMessages(`run:${runId}`)[0]?.handoff)
    const before = providerFaults.starts
    await restartHostAndRuntime()
    await vi.waitFor(() => expect(providerFaults.starts).toBe(before + 1), WAIT)
    await observationClock.observe(500)
    await edgesAnswered()
    expect(providerFaults.starts).toBe(before + 1)
    const replacement = readMailHandoff(db.getUnreadMessages(`run:${runId}`)[0]?.handoff)
    expect(held?.kind).toBe('structured')
    expect(replacement?.kind).toBe('structured')
    if (held?.kind !== 'structured' || replacement?.kind !== 'structured') {
      throw new Error('Missing reservation')
    }
    expect(replacement.authorizationId).toBe(held.authorizationId)
    expect(replacement.operationId).not.toBe(held.operationId)
    expect(db.getUnreadMessages(`run:${runId}`)[0]?.recovery_used).toBe(0)
  })

  /** Mail for a chat whose agent is stopped and whose every start is refused; resolves after it. */
  async function refusedStartsFor(
    refusal: () => Error
  ): Promise<{ runId: string; starts: number }> {
    observationClock.start()
    await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    await host.close(COORDINATOR, 'evict')
    providerFaults.refuseStart = refusal
    const before = providerFaults.starts
    await finishWorker(taskId)
    await vi.waitFor(() => expect(providerFaults.starts).toBe(before + 1), WAIT)
    await vi.waitFor(
      () =>
        expect(
          db.getUnreadMessages(`run:${runId}`).filter((message) => message.delivered_at === null)
        ).toHaveLength(1),
      WAIT
    )
    // A fixed window, not a poll: a retry loop would start it several times in it.
    await observationClock.observe(1_500)
    return { runId, starts: providerFaults.starts - before }
  }

  it.each([
    [
      'one the person must fix',
      () => new AgentSessionAcquisitionRefusal('no login', 'notSignedIn')
    ],
    [
      'an account switch in progress',
      () =>
        new AgentSessionPreSpawnError(new Error('switching accounts'), {
          reason: 'accountSwitchInProgress'
        })
    ]
  ])(
    'holds mail after a start refused as %s until a turn runs, adding nothing on later edges',
    async (_label, refusal) => {
      const { runId, starts } = await refusedStartsFor(refusal)
      expect(starts).toBe(1)
      // Later edges replay the refusal: no start, and no new pointer and failure rows in the chat.
      const before = providerFaults.starts
      for (let edge = 0; edge < 5; edge += 1) {
        runtime.onStructuredSessionStatusForMail({ sessionId: COORDINATOR, status: 'idle' })
        await observationClock.observe(100)
      }
      await edgesAnswered()
      expect(providerFaults.starts).toBe(before)
      expect(await mailSends()).toHaveLength(1)
      expect(
        db.getUnreadMessages(`run:${runId}`).filter((message) => message.delivered_at === null)
      ).toHaveLength(1)

      // Fixed, the person's next message starts the agent, and the pointer follows its turn.
      providerFaults.refuseStart = null
      expect(await sendUserMessage(COORDINATOR, 'again')).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(providerFaults.starts).toBe(before + 1), WAIT)
      const revived = connectionFor(COORDINATOR)
      await vi.waitFor(() => expect(revived.turns.length).toBeGreaterThanOrEqual(1), WAIT)
      expect(revived.turns[0]!.text).toContain('again')
      await settleTurn(COORDINATOR, 0)
      await vi.waitFor(() => expect(revived.turns).toHaveLength(2), WAIT)
      expect(revived.turns[1]!.text).toMatch(MAIL)
    }
  )

  it('keeps uncertain input readable after rewind without inferring ownership from a later turn', async () => {
    const chat = await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    providerFaults.crashOnTurnStart = 'exit-then-throw'
    await finishWorker(taskId)
    await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(1), WAIT)
    await edgesAnswered()
    // What a rewind's recovery does: the journal is rebuilt, and no send is on record any more.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host keeps its conversations private; this is the one journal call rewind recovery makes.
    const open = (host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> })
      .sessions
    const fence = host.deps.store.getRecord(COORDINATOR)!.lease.runtimeFence
    await open.get(COORDINATOR)!.journal.replaceEpochItems('handle_forked', fence, [])
    expect(await mailSends()).toEqual([])

    providerFaults.crashOnTurnStart = 'off'
    expect(await sendUserMessage(COORDINATOR, 'again')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(2), WAIT)
    const revived = connectionFor(COORDINATOR)
    expect(revived).not.toBe(chat)
    await settleTurn(COORDINATOR, revived.turns.length - 1)
    await edgesAnswered()
    expect(revived.turns).toHaveLength(1)
    expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
      count: 1
    })
  })

  it('rotates an unadmitted transport key only after the host positively refuses it as expired', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    // The first pointer is refused before the host records it, so the journal holds no verdict.
    const realSend = host.send
    let expire = false
    const refused = vi.spyOn(host, 'send').mockImplementation((_caller, _params) => {
      if (!expire) {
        return Promise.resolve({
          ok: false as const,
          refusal: refuse(
            'agent_session_operation_invalid',
            { reason: 'conversationCommandInFlight' },
            'busy'
          )
        })
      }
      expire = false
      refused.mockImplementation((nextCaller, nextParams) => realSend(nextCaller, nextParams))
      return Promise.resolve({
        ok: false as const,
        refusal: refuse(
          'agent_session_operation_expired',
          { reason: 'operationExpired' },
          'This operation is too old to admit.'
        )
      })
    })
    await finishWorker(taskId)
    await vi.waitFor(() => expect(refused.mock.calls.length).toBeGreaterThanOrEqual(2), WAIT)
    const held = readMailHandoff(db.getUnreadMessages(`run:${runId}`)[0]?.handoff)
    expect(held).toMatchObject({ sessionId: COORDINATOR, operationId: expect.any(String) })
    if (held?.kind !== 'structured') {
      throw new Error('Missing reservation')
    }
    const heldId = held.operationId
    expect(heldId).not.toBe('')
    expect(
      new Set(refused.mock.calls.map(([, params]) => params.envelope.clientOperationId))
    ).toEqual(new Set([heldId]))
    expect(await mailSends()).toEqual([])

    // No edge for a day: the host would now refuse that id as expired, on every retry.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + 60_000)
      expire = true
      await edgesAnswered()
      await vi.waitFor(
        () => expect(chat.turns.map(turnText)).toEqual([expect.stringMatching(MAIL)]),
        WAIT
      )
      await vi.waitFor(async () => {
        const sends = await mailSends()
        expect(sends).toHaveLength(1)
        expect(sends[0]).toBeTruthy()
        expect(sends[0]).not.toBe(heldId)
        expect(readMailHandoff(db.getUnreadMessages(`run:${runId}`)[0]?.handoff)).toMatchObject({
          sessionId: COORDINATOR,
          operationId: sends[0],
          authorizationId: held.authorizationId
        })
      }, WAIT)
      expect(
        db.getUnreadMessages(`run:${runId}`).filter((message) => message.delivered_at === null)
      ).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('points mail a refused turn left in doubt again with the next result, counting both', async () => {
    // A failed turn/start cannot prove the turn never started, so the host records it `unknown`
    // and a resend under its id replays that. The next result's pointer does not wait behind
    // that doubt: it names both messages, and the chat's own `check` reads them.
    const chat = await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    const second = await call(
      'orchestration.taskCreate',
      { spec: 'more' },
      { sessionId: COORDINATOR }
    )
    providerFaults.refuseTurnStarts = 1
    const before = codex.connections.length
    await finishWorker(taskId)
    await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(1), WAIT)
    await edgesAnswered()
    expect(chat.turns).toHaveLength(0)

    await finishWorker(idOf(second.task), { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    expect(turnText(chat.turns[0]!)).toMatch(MAIL)
    expect(await queuedCardTexts()).toEqual([])
    expect(codex.connections.length).toBe(before)
  })

  it('points a coordinator whose agent is not running through the send alone, which starts it', async () => {
    await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    // What the idle sweep leaves of a chat nobody is looking at: agent stopped, no map entry.
    await host.close(COORDINATOR, 'evict')
    expect(host.hasSession(COORDINATOR)).toBe(false)
    const before = codex.connections.length

    await finishWorker(taskId)

    // Nothing holds or wakes the session first: the pointer's accepted send starts its agent.
    await vi.waitFor(() => expect(codex.connections.length).toBe(before + 1), WAIT)
    const revived = connectionFor(COORDINATOR)
    await vi.waitFor(() => expect(revived.turns).toHaveLength(1), WAIT)
    expect(revived.turns[0]!.text).toMatch(MAIL)
    await settleTurn(COORDINATOR, 0)
    expect(await userTexts(COORDINATOR)).toEqual([expect.stringMatching(MAIL)])
  })

  it('holds reports invisibly until idle, then completes one attributed turn per report in order', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const second = await call(
      'orchestration.taskCreate',
      { spec: 'more' },
      { sessionId: COORDINATOR }
    )
    expect(await sendUserMessage(COORDINATOR, 'go')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    const notify = (method: string, params: Record<string, unknown>) =>
      chat.handlers.onNotification?.(method, { threadId: chat.threadId, ...params })
    const startTurn = async (index: number) => {
      notify('turn/started', { turn: { id: `turn-${index + 1}`, status: 'inProgress' } })
      notify('item/completed', {
        turnId: `turn-${index + 1}`,
        item: {
          type: 'userMessage',
          id: `input-${index}`,
          clientId: chat.turns[index]!.clientUserMessageId,
          content: [{ type: 'text', text: turnText(chat.turns[index]!) }]
        }
      })
      await host.flushStreamedEvents(COORDINATOR)
    }
    const finishTurn = async (index: number) => {
      notify('item/completed', {
        turnId: `turn-${index + 1}`,
        item: { type: 'agentMessage', id: `reply-${index}`, text: `Finished ${index}` }
      })
      notify('thread/status/changed', { status: { type: 'idle' } })
      notify('turn/completed', { turn: { id: `turn-${index + 1}`, status: 'completed' } })
      await host.flushStreamedEvents(COORDINATOR)
    }
    await startTurn(0)

    await finishWorker(taskId)
    await finishWorker(idOf(second.task), { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
    await edgesAnswered()
    const pending = db
      .getUnreadMessages(`run:${runId}`)
      .filter((message) => message.delivered_at === null)
    expect(pending.map((message) => message.from_handle)).toEqual(['term_worker', 'term_worker_2'])
    expect(chat.turns).toHaveLength(1)
    expect(await userTexts(COORDINATOR)).toEqual(['go'])
    expect(await mailSends()).toEqual([])
    expect(await queuedCardTexts()).toEqual([])
    expect(chat.steers).toEqual([])

    await finishTurn(0)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    expect(turnText(chat.turns[1]!)).toMatch(MAIL)
    expect(turnText(chat.turns[1]!)).toContain('**From:** `term_worker` · worker_done')
    await startTurn(1)
    await edgesAnswered()
    expect(chat.turns).toHaveLength(2)
    await vi.waitFor(
      () =>
        expect(
          db
            .getUnreadMessages(`run:${runId}`)
            .filter((message) => message.delivered_at === null)
            .map((message) => message.id)
        ).toEqual([pending[1]!.id]),
      WAIT
    )

    await finishTurn(1)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(3), WAIT)
    expect(turnText(chat.turns[2]!)).toMatch(MAIL)
    expect(turnText(chat.turns[2]!)).toContain('**From:** `term_worker_2` · worker_done')
    await startTurn(2)
    await finishTurn(2)
    const snapshot = await host.journalSnapshot(COORDINATOR)
    const sent = snapshot.items.flatMap((item) =>
      item.body.kind === 'message' && item.body.from ? [item.body.from] : []
    )
    expect(sent).toEqual(
      pending.map((message) =>
        expect.objectContaining({
          orchestration: expect.objectContaining({
            message: 'mail-notice',
            carriesMailContent: true,
            mailbox: `run:${runId}`,
            messages: [
              expect.objectContaining({ messageId: message.id, from: message.from_handle })
            ]
          })
        })
      )
    )
    expect(
      snapshot.items.filter((item) => item.body.kind === 'turn').map((item) => item.body)
    ).toEqual(
      [1, 2, 3].map((index) =>
        expect.objectContaining({ turnId: `turn-${index}`, state: 'completed' })
      )
    )
    expect(new Set(await mailSends()).size).toBe(2)
    await vi.waitFor(
      () =>
        expect(
          db.getUnreadMessages(`run:${runId}`).filter((message) => message.delivered_at === null)
        ).toEqual([]),
      WAIT
    )
    runtime.onStructuredSessionStatusForMail({ sessionId: COORDINATOR, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(chat.turns).toHaveLength(3)
    expect(chat.steers).toEqual([])
    expect(await queuedCardTexts()).toEqual([])
    expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
      runId,
      count: 0
    })
  })
})

describe('a /clear keeps the chat its orchestration address', () => {
  it("delivers the conversation's Run to its fresh context under the same address", async () => {
    await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const generation = db.getRunRaw(runId)!.consumer_generation
    const cleared = await clearChat(COORDINATOR)
    expect(cleared).toBe(COORDINATOR)
    const opened = codex.connections.length

    // The worker's result starts the fresh context on a new thread.
    await finishWorker(taskId)
    await vi.waitFor(() => expect(connectionFor(cleared).turns).toHaveLength(1), WAIT)
    const next = connectionFor(cleared)
    expect(codex.connections.slice(opened)).toEqual([next])
    expect(next.methods.filter((method) => method.startsWith('thread/'))).toEqual(['thread/start'])
    expect(next.turns[0]!.text).toMatch(MAIL)
    await settleTurn(cleared, 0)
    await expect(
      call('orchestration.runCurrent', {}, { sessionId: cleared })
    ).resolves.toMatchObject({ run: { id: runId } })
    await expect(call('orchestration.check', {}, { sessionId: cleared })).resolves.toMatchObject({
      runId,
      count: 1
    })
    // Clear preserves the original Run binding and consumer generation.
    expect(db.getRunRaw(runId)).toMatchObject({
      coordinator_orca_session_id: COORDINATOR,
      consumer_generation: generation
    })
  })

  it('delivers oldest eligible across delayed direct, Run and Dispatch address callbacks', async () => {
    await openChat(COORDINATOR)
    const peer = await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    const dispatched = await call(
      'orchestration.dispatch',
      { task: taskId, to: `orca_session_id:${PEER_CHAT}` },
      { sessionId: COORDINATOR }
    )
    const run = await call(
      'orchestration.runCreate',
      { objective: 'peer coordinates' },
      { sessionId: PEER_CHAT }
    )
    await sendUserMessage(PEER_CHAT, 'working')
    const realRead = host.readMailHandoffEvidence
    let unblock = () => {}
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const read = vi
      .spyOn(host, 'readMailHandoffEvidence')
      .mockImplementationOnce(async (...args) => {
        await blocked
        return realRead(...args)
      })
    await call(
      'orchestration.send',
      { to: `orca_session_id:${PEER_CHAT}`, subject: 'older direct' },
      { sessionId: COORDINATOR }
    )
    await vi.waitFor(() => expect(read).toHaveBeenCalled(), WAIT)
    await call(
      'orchestration.send',
      { to: `run:${idOf(run.run)}`, subject: 'newer Run' },
      { sessionId: COORDINATOR }
    )
    await call(
      'orchestration.send',
      { to: `dispatch:${idOf(dispatched.dispatch)}`, subject: 'newest Dispatch' },
      { sessionId: COORDINATOR }
    )
    unblock()
    await settleTurn(PEER_CHAT, 0, 'completed')
    for (const [index, text] of ['older direct', 'newer Run', 'newest Dispatch'].entries()) {
      await vi.waitFor(() => expect(peer.turns).toHaveLength(index + 2), WAIT)
      expect(turnText(peer.turns[index + 1]!)).toContain(text)
      await settleTurn(PEER_CHAT, index + 1, 'completed')
    }
    read.mockRestore()
  })

  it('points mail the earlier context never took at the fresh context, without a user message', async () => {
    observationClock.start()
    await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    await host.close(COORDINATOR, 'evict')
    providerFaults.refuseStart = () => new AgentSessionAcquisitionRefusal('no login', 'notSignedIn')
    await finishWorker(taskId)
    await vi.waitFor(
      async () =>
        expect((await host.journalSnapshot(COORDINATOR)).submissions[0]?.dispatchState).toBe(
          'rejected'
        ),
      WAIT
    )
    providerFaults.refuseStart = null

    const cleared = await clearChat(COORDINATOR)
    expect(cleared).toBe(COORDINATOR)
    await observationClock.observe(2_000)
    await vi.waitFor(() => expect(connectionFor(cleared).turns[0]?.text).toMatch(MAIL), WAIT)
    await settleTurn(cleared, 0)
    await vi.waitFor(
      () =>
        expect(
          db.getUnreadMessages(`run:${runId}`).filter((message) => message.delivered_at === null)
        ).toEqual([]),
      WAIT
    )
  })

  it('keeps a Run under the same conversation address through repeated clears', async () => {
    await openChat(COORDINATOR)
    const firstClear = await clearChat(COORDINATOR)
    await startClearedContext(firstClear)
    const created = await call(
      'orchestration.runCreate',
      { objective: 'next' },
      { sessionId: firstClear }
    )
    const runId = idOf(created.run)
    expect(db.getRunRaw(runId)!.coordinator_orca_session_id).toBe(COORDINATOR)
    const cleared = await clearChat(firstClear)
    await startClearedContext(cleared)

    await expect(
      call('orchestration.runCurrent', {}, { sessionId: cleared })
    ).resolves.toMatchObject({ run: { id: runId } })
    expect(db.getRunRaw(runId)!.coordinator_orca_session_id).toBe(COORDINATOR)
    // What it sends carries the same address.
    await openChat(PEER_CHAT)
    await expect(
      call(
        'orchestration.send',
        { to: `orca_session_id:${PEER_CHAT}`, subject: 'hi' },
        { sessionId: cleared }
      )
    ).resolves.toMatchObject({ message: { from_handle: `orca_session_id:${COORDINATOR}` } })
  })

  it('binds a Run a cleared chat creates or uses to the same conversation at the current generation', async () => {
    const root = COORDINATOR
    const boundOrcaSessionId = (runId: string): string | null =>
      currentRunCoordinatorOrcaSessionId(db.getRunRaw(runId)!)
    await openChat(COORDINATOR)
    const firstClear = await clearChat(COORDINATOR)
    await startClearedContext(firstClear)
    const first = idOf(
      (await call('orchestration.runCreate', { objective: 'first' }, { sessionId: firstClear })).run
    )
    expect(db.getRunRaw(first)).toMatchObject({
      coordinator_orca_session_id: root,
      coordinator_orca_session_id_generation: db.getRunRaw(first)!.consumer_generation
    })
    expect(boundOrcaSessionId(first)).toBe(root)
    const second = idOf(
      (await call('orchestration.runCreate', { objective: 'second' }, { sessionId: firstClear }))
        .run
    )
    expect(boundOrcaSessionId(first)).toBeNull()

    const cleared = await clearChat(firstClear)
    await startClearedContext(cleared)
    await call('orchestration.runUse', { id: first }, { sessionId: cleared })
    const rebound = db.getRunRaw(first)!
    expect(rebound.coordinator_orca_session_id).toBe(root)
    expect(rebound.coordinator_orca_session_id_generation).toBe(rebound.consumer_generation)
    expect(boundOrcaSessionId(second)).toBeNull()
    await expect(
      call('orchestration.runCurrent', {}, { sessionId: cleared })
    ).resolves.toMatchObject({ run: { id: first } })
  })

  it('lands successive mail at the same conversation after repeated clears', async () => {
    await openChat(PEER_CHAT)
    const firstClear = await clearChat(PEER_CHAT)
    const cleared = await clearChat(firstClear)
    expect(firstClear).toBe(PEER_CHAT)
    expect(cleared).toBe(PEER_CHAT)
    // The first ping starts the fresh context, which neither clear did.
    for (const [index, spelling] of [PEER_CHAT, firstClear, cleared].entries()) {
      const sent = await call('orchestration.send', {
        from: 'term_worker',
        to: `orca_session_id:${spelling}`,
        subject: `ping ${index}`
      })
      expect(sent).toMatchObject({ message: { to_handle: `orca_session_id:${PEER_CHAT}` } })
      await vi.waitFor(() => expect(connectionFor(cleared).turns).toHaveLength(index + 1), WAIT)
      await settleTurn(cleared, index)
      // Read each ping before the next is sent, so each check holds exactly one.
      const checked = await call('orchestration.check', {}, { sessionId: cleared })
      expect(checked).toMatchObject({ count: 1, messages: [{ subject: `ping ${index}` }] })
      await call('orchestration.check', { ack: checked.deliveryId }, { sessionId: cleared })
    }
  })
})

describe('any live session is addressable by its id', () => {
  it('lands mail sent to `orca_session_id:<id>` as a turn in that chat, which a flagless check reads', async () => {
    const peer = await openChat(PEER_CHAT)

    const sent = await call('orchestration.send', {
      from: 'term_worker',
      to: `orca_session_id:${PEER_CHAT}`,
      subject: 'ping'
    })
    expect(sent).toMatchObject({ message: { to_handle: `orca_session_id:${PEER_CHAT}` } })

    await vi.waitFor(() => expect(peer.turns).toHaveLength(1), WAIT)
    // Direct mail is not in a Run, so the pointer names no `--run`.
    expect(turnText(peer.turns[0]!)).toMatch(MAIL)
    await settleTurn(PEER_CHAT, 0)
    const checked = await call('orchestration.check', {}, { sessionId: PEER_CHAT })
    expect(checked).toMatchObject({ count: 1, messages: [{ subject: 'ping' }] })
  })

  it('refuses mail to a chat that was closed, before storing it', async () => {
    await openChat(PEER_CHAT)
    await host.setSessionTabVisibility(PEER_CHAT, false)
    const response = await dispatcher.dispatch(
      request('orchestration.send', {
        from: 'term_worker',
        to: `orca_session_id:${PEER_CHAT}`,
        subject: 'ping'
      })
    )
    expect(response).toMatchObject({ ok: false, error: { code: 'session_caller_not_live' } })
    expect(db.getInbox(100)).toEqual([])
  })
})
