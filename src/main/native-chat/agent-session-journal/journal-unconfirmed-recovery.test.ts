import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionStoppedHistoryOwed } from '../../../shared/agent-session-stopped-history'
import { structuredAgentSessionCurrentWork } from '../agent-session-wire/structured-agent-session-current-work'
import { recordStructuredAgentSessionStartFailure } from '../agent-session-wire/structured-agent-session-start-failure-row'
import { settleObservedExitForTest } from '../agent-session-wire/structured-agent-session-observed-exit.test-fixture'
import { readQueuePublication } from '../agent-session-wire/structured-agent-session-queued-publication'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import type { AgentSessionJournal } from './journal-store'

const journals = createTrackedJournalOpener()
const identity = {
  sessionId: 'recovery-flow',
  workspaceId: 'ws',
  hostId: 'local',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle('thread')
}
const body = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})
let root: string
let journal: AgentSessionJournal
let held: Set<string>
let lease: ReturnType<typeof agentSessionLeaseFixture>
let clock = 1000
const work = () =>
  structuredAgentSessionCurrentWork(journal, {
    record: agentSessionRecordFixture(lease),
    child: { fence: 7, heldSends: () => held }
  })
const open = async () => {
  journal = await journals.open({ identity, stateDirectory: root, now: () => ++clock })
  journal.queuedMessages.recoveryWork = work
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'b1-recovery-'))
  held = new Set()
  lease = agentSessionLeaseFixture({ sessionId: identity.sessionId })
  await open()
})
afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})
const cardId = (id: string) => `recovery:${id}`
async function send(id: string, handed = true, message = body(id)) {
  await journal.appendSubmission({
    clientMessageId: id,
    body: message,
    payloadFingerprint: agentSessionSendBodyFingerprint(identity.sessionId, message),
    fence: 7,
    origin: 'client',
    source: { kind: 'user' },
    handoverRecorded: true
  })
  if (handed) {
    await journal.resolveDispatch({
      clientMessageId: id,
      state: 'pending',
      fence: 7,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  }
}
async function ended(id = 'turn') {
  await journal.appendItem(
    { provider: 'legacy', agent: 'codex', sessionId: 'thread', recordId: `turn-lifecycle:${id}` },
    { kind: 'turn', turnId: id, state: 'completed' },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}
async function receipt(id: string) {
  await journal.resolveDispatch({
    clientMessageId: id,
    state: 'accepted',
    fence: 7,
    providerIdentity: { provider: 'codex', threadId: 'thread', turnId: 'receipt', ordinal: clock }
  })
}

it('keeps one actionable copy, adopts only a person’s action, and never duplicates the stopped-text carry', async () => {
  await journal.appendItem(
    { provider: 'legacy', agent: 'codex', sessionId: 'thread', recordId: 'turn-lifecycle:turn' },
    { kind: 'turn', turnId: 'turn', state: 'running' },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await send('send')
  await ended()
  const copy = journal.queuedMessages.get(cardId('send'))!
  expect(copy.state).toBe('returned')
  expect(
    journal.queuedMessages.editLeases.acquire(
      { callerKey: 'editor', editId: 'edit' },
      { messageId: copy.messageId, fingerprint: copy.fingerprint }
    ).status
  ).toBe('held')
  expect(
    await journal.queuedMessages.update({
      messageId: copy.messageId,
      expectedBodyFingerprint: copy.fingerprint,
      text: 'send'
    })
  ).toMatchObject({ status: 'updated' })
  await journal.appendSubmission(
    {
      clientMessageId: 'fresh',
      body: copy.body,
      payloadFingerprint: copy.fingerprint,
      fence: 7,
      origin: 'client',
      handoverRecorded: true
    },
    { messageId: copy.messageId, expect: 'returned' }
  )
  expect(journal.queuedMessages.get(copy.messageId)).toMatchObject({
    state: 'dispatched',
    consumedAs: 'fresh',
    recovers: 'send'
  })
  await receipt('send')
  expect(journal.queuedMessages.get(copy.messageId)?.consumedAs).toBe('fresh')
  await send('late')
  await ended('late-end')
  const late = journal.queuedMessages.get(cardId('late'))!
  await receipt('late')
  expect(journal.queuedMessages.get(late.messageId)).toBeNull()
  expect(
    await journal.queuedMessages.update({
      messageId: late.messageId,
      expectedBodyFingerprint: late.fingerprint,
      text: 'typing'
    })
  ).toMatchObject({ status: 'gone' })
  await send('edit')
  await ended('edit-end')
  const edit = journal.queuedMessages.get(cardId('edit'))!
  await journal.queuedMessages.update({
    messageId: edit.messageId,
    expectedBodyFingerprint: edit.fingerprint,
    text: 'changed'
  })
  await receipt('edit')
  expect(journal.queuedMessages.get(edit.messageId)).toMatchObject({
    state: 'waiting',
    recovers: 'edit'
  })
  await send('delete')
  await ended('delete-end')
  await journal.queuedMessages.withdraw([cardId('delete')])
  expect(journal.queuedMessages.get(cardId('delete'))?.state).toBe('withdrawn')
  await send('stopped', false)
  await journal.stops.accept({ event: { reason: 'user-stop' }, fence: 7, liveTurnId: () => null })
  const carried = agentSessionStoppedHistoryOwed({
    submissions: journal.submissions(),
    carried: journal.stoppedHistoryCarried(),
    clearSequence: 0,
    body: (id) => journal.itemBody(agentJournalSubmissionKey(id))
  })
  expect(carried.map((entry) => entry.clientMessageId)).toContain('stopped')
  expect(journal.queuedMessages.get(cardId('stopped'))).toBeNull()
  await send('carrier', false)
  await journal.resolveDispatch({
    clientMessageId: 'carrier',
    state: 'pending',
    fence: 7,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE,
    carries: ['stopped']
  })
  await ended('carrier-end')
  expect(journal.queuedMessages.get(cardId('carrier'))?.body).toEqual(body('carrier'))
  expect(
    agentSessionStoppedHistoryOwed({
      submissions: journal.submissions(),
      carried: journal.stoppedHistoryCarried(),
      clearSequence: 0,
      body: (id) => journal.itemBody(agentJournalSubmissionKey(id))
    })
  ).toEqual([])
  await send('boundary')
  held.add('boundary')
  await ended('boundary-end')
  expect(journal.queuedMessages.get(cardId('boundary'))).toBeNull()
  await receipt('boundary')
  held.delete('boundary')
  expect(journal.queuedMessages.get(cardId('boundary'))).toBeNull()
})

it('re-derives after restart, waits for owner reconciliation, and retires an unchanged copy on an exact replay receipt', async () => {
  await send('restart')
  await ended('replayed')
  await journal.close()
  await open()
  await journal.markPendingSubmissionsUnknown(7)
  lease.unreconciled = true
  journal.queuedMessages.recoveryWork = () =>
    structuredAgentSessionCurrentWork(journal, {
      record: agentSessionRecordFixture(lease),
      child: null
    })
  expect(journal.queuedMessages.get(cardId('restart'))).toBeNull()
  lease.unreconciled = false
  lease.claimStatus = 'released'
  expect(journal.queuedMessages.get(cardId('restart'))?.state).toBe('returned')
  const { catchUpCodexThread } = await import('../../codex/codex-structured-thread-catch-up')
  const { createDeferredStructuredAgentSessionEventSink } =
    await import('../agent-session-wire/structured-agent-session-event-sink')
  const { testEventSinkLogging } =
    await import('../agent-session-wire/structured-agent-session-logger-test-support')
  const sink = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  sink.bind({ journal, fence: 7, publish: () => {} })
  await catchUpCodexThread({
    sessionId: identity.sessionId,
    threadId: 'thread',
    sink: sink.sink,
    connection: {
      request: async () => ({
        data: [
          {
            id: 'replayed',
            status: 'completed',
            itemsView: 'full',
            items: [
              {
                type: 'userMessage',
                id: 'receipt',
                clientId: 'restart',
                content: [{ type: 'text', text: 'provider rendering' }]
              }
            ]
          }
        ],
        nextCursor: null
      })
    },
    onReceipt: (clientMessageId, providerIdentity) =>
      journal
        .acceptLate({
          clientMessageId,
          providerIdentity,
          state: 'accepted',
          fence: 7
        })
        .then(() => {})
  })
  sink.close()
  expect(journal.submission('restart')?.dispatchState).toBe('accepted')
  expect(journal.queuedMessages.get(cardId('restart'))).toBeNull()
})

it('shows the stopped queue again when a post-Stop direct send is no longer held', async () => {
  await journal.queuedMessages.insert({ messageId: 'waiting', body: body('waiting') })
  await journal.appendStopEvent({ reason: 'user-stop' }, 7)
  await send('post-stop')
  held.add('post-stop')
  const publish = () =>
    readQueuePublication(journal, () => ({
      record: agentSessionRecordFixture(lease),
      work: work()
    }))
  expect(publish().queuePause).toBeNull()
  held.delete('post-stop')
  expect(publish().queuePause).toEqual({ reason: 'stopped' })
})

it('keeps an image as a returned card on both failed-start routes in the rejection transaction', async () => {
  const image: AgentJournalMessageItem = {
    ...body('image'),
    blocks: [
      { type: 'text', text: 'image' },
      { type: 'image-ref', path: '/b1-image.png' }
    ]
  }
  const failure = agentSessionFailureWords(agentSessionFailureFact('startFailed'), {
    surface: 'rejection'
  })
  await send('queued-start', false, image)
  await recordStructuredAgentSessionStartFailure(
    { journal, fence: 7 },
    { ...failure, startKey: 'start' }
  )
  expect(journal.queuedMessages.get('queued-start')).toMatchObject({
    state: 'returned',
    body: image
  })
  await send('handed-start', true, image)
  await settleObservedExitForTest({
    journal,
    sessionId: identity.sessionId,
    fence: 7,
    settlementId: 'failed-child',
    verdict: { state: 'interrupted', completedAt: clock },
    pendingSubmissionReason: 'exited',
    exitedDuringStartup: { generation: 'child' },
    showUnexpectedExitOutcome: true
  })
  expect(journal.queuedMessages.get('handed-start')).toMatchObject({
    state: 'returned',
    body: image
  })
  await journal.close()
  await open()
  expect(journal.queuedMessages.get('handed-start')).toMatchObject({
    state: 'returned',
    body: image
  })
})

it('confirms id-less live receipts and releases unopened error/interrupt holds without deciding delivery', async () => {
  const { createCodexDispatchEchoes, readCodexDispatchEcho } =
    await import('../../codex/codex-structured-dispatch-echo')
  const { settleCodexSendsInEndedTurn } =
    await import('../../codex/codex-structured-turn-end-settlement')
  const remembered: string[] = []
  const echoes = createCodexDispatchEchoes(undefined, (id) => {
    remembered.push(id)
  })
  journal.queuedMessages.recoveryWork = () =>
    structuredAgentSessionCurrentWork(journal, {
      record: agentSessionRecordFixture(lease),
      child: { fence: 7, heldSends: echoes.heldSends }
    })
  await send('opener')
  echoes.arm('opener')
  echoes.expect('opener', 'thread', 'start', [{ type: 'text', text: 'opener' }])
  echoes.bindTurn('opener', 'thread', 'opened', 'start')
  const identity = { provider: 'codex' as const, threadId: 'thread', turnId: 'opened', ordinal: 1 }
  const echo = readCodexDispatchEcho(
    { type: 'userMessage', id: 'old-user', clientId: null, content: [] },
    identity,
    echoes
  )
  expect(echo?.clientMessageId).toBe('opener')
  if (!echo) {
    throw new Error('missing opener receipt')
  }
  await receipt(echo.clientMessageId)
  echoes.settle(echo.clientMessageId)
  await send('steer')
  echoes.arm('steer')
  echoes.expect('steer', 'thread', 'steer', [{ type: 'text', text: 'steer' }])
  echoes.bindTurn('steer', 'thread', 'opened', 'steer')
  expect(
    readCodexDispatchEcho(
      { type: 'userMessage', id: 'steer-item', content: [{ type: 'text', text: 'steer' }] },
      { ...identity, ordinal: 2 },
      echoes
    )?.clientMessageId
  ).toBe('steer')
  await receipt('steer')
  echoes.settle('steer')
  await ended('opened')
  expect(journal.queuedMessages.get(cardId('opener'))).toBeNull()
  expect(journal.queuedMessages.get(cardId('steer'))).toBeNull()
  echoes.arm('late-opener')
  echoes.expect('late-opener', 'thread', 'start', [{ type: 'text', text: 'late' }])
  const earlyReceipt = { ...identity, turnId: 'late-turn', ordinal: 0 }
  expect(echoes.receipt(earlyReceipt, [])).toBeNull()
  echoes.endTurn('thread', 'late-turn', { status: 'completed' })
  echoes.bindTurn('late-opener', 'thread', 'late-turn', 'start')
  expect(remembered).toEqual(['late-opener'])
  expect(echoes.receipt(earlyReceipt, [])).toBe('late-opener')
  await send('legacy-error')
  echoes.arm('legacy-error')
  echoes.bindTurn('legacy-error', 'thread', 'unopened', 'start')
  settleCodexSendsInEndedTurn(
    { threadId: 'thread', dispatchEchoes: echoes },
    {
      sessionId: identity.threadId,
      method: 'error',
      params: {
        threadId: 'thread',
        turnId: 'unopened',
        willRetry: false,
        error: { message: 'failed' }
      }
    }
  )
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'error-row' },
    {
      kind: 'status',
      text: 'failed',
      providerFrame: {
        provider: 'codex',
        kind: 'notification:error',
        payload: { head: '{}', byteLength: 2, digest: '', truncated: false }
      }
    },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  expect(journal.queuedMessages.get(cardId('legacy-error'))?.state).toBe('returned')
  expect(
    journal.submissions().find((send) => send.clientMessageId === 'legacy-error')?.dispatchState
  ).toBe('pending')
  await send('unopened-stop')
  echoes.arm('unopened-stop')
  echoes.bindTurn('unopened-stop', 'thread', 'stop-turn', 'start')
  await journal.appendStopEvent({ reason: 'user-stop' }, 7)
  expect(journal.queuedMessages.get(cardId('unopened-stop'))).toBeNull()
  echoes.endTurn('thread', 'stop-turn', { status: 'interrupted' })
  expect(journal.queuedMessages.get(cardId('unopened-stop'))?.state).toBe('returned')
})
