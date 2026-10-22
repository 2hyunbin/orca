import { afterEach, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE } from '../../../shared/native-chat-usage-limit-cut'
import { refuse } from '../../../shared/agent-session-wire'
import {
  createRestTestRig,
  foundRestTestChat,
  restTestSend,
  REST_TEST_CALLER,
  REST_TEST_SESSION as SESSION,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'

let rig: RestTestRig | undefined
let enabled = true
let asleep = false
let changed = () => {}
afterEach(async () => {
  await rig?.dispose()
  vi.restoreAllMocks()
})

async function setup(stale = false) {
  enabled = true
  asleep = false
  rig = await createRestTestRig({
    idleSweep: { intervalMs: 3_600_000 },
    usageLimitAutoContinue: {
      isEnabled: () => enabled,
      isWorkspaceAsleep: () => asleep,
      subscribe: (cb) => {
        changed = cb
        return () => {}
      }
    }
  })
  const current = rig
  await foundRestTestChat(current)
  const journal = current.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const resetsAt = current.clock.now + (stale ? -1 : 30_000)
  const key = { provider: 'orca' as const, clientMessageId: 'limited-turn' }
  const turnItemId = agentJournalItemKey(key)
  await journal.appendItem(
    key,
    {
      kind: 'turn',
      turnId: 'turn-1',
      state: 'completed',
      outcome: 'failure',
      startedAt: current.clock.now,
      completedAt: current.clock.now
    },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'limit' },
    {
      kind: 'status',
      ...agentSessionFailureWords(
        { kind: 'usageLimitReached', usageLimit: { resetsAt } },
        { surface: 'row' }
      )
    },
    { fence: 1, turnScope: { kind: 'turn', turnItemId } }
  )
  const sweep = current.host.usageLimitContinue
  return { current, journal, resetsAt, turnItemId, sweep }
}

it('waits for the buffered reset, accepts one ordinary continuation and never sends twice', async () => {
  const { current, sweep, resetsAt } = await setup()
  expect(sweep.readState(SESSION)?.state).toBe('scheduled')
  expect(current.host.readStatusSummary(SESSION)?.usageLimitContinue?.state).toBe('scheduled')
  const send = vi.spyOn(current.host, 'send')
  current.clock.now = resetsAt + 14_999
  await sweep.tick()
  expect(send).not.toHaveBeenCalled()
  current.clock.now++
  await sweep.tick()
  await sweep.tick()
  expect(send).toHaveBeenCalledOnce()
  expect(send.mock.calls[0]?.[0]).toEqual({ callerKey: 'trusted-local:usage-limit-continue' })
  expect(send.mock.calls[0]?.[1].body.blocks).toEqual([
    { type: 'text', text: NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE }
  ])
  expect(sweep.readState(SESSION)).toBeUndefined()
  await vi.waitFor(() => expect(current.adapter.dispatch).toHaveBeenCalledTimes(2))
})

it.each(['cancel', 'off', 'message', 'stale', 'sleep'] as const)(
  'does not continue after %s',
  async (reason) => {
    const { current, sweep, resetsAt, turnItemId } = await setup(reason === 'stale')
    if (reason === 'cancel') {
      await sweep.cancel({ sessionId: SESSION, turnItemId, resetsAt })
      await sweep.cancel({ sessionId: SESSION, turnItemId, resetsAt })
      expect(current.store.getRecord(SESSION)?.usageLimitContinueCancel).toEqual({
        turnItemId,
        resetsAt
      })
      expect(sweep.readState(SESSION)?.state).toBe('cancelled')
      await current.restart()
      expect(current.store.getRecord(SESSION)?.usageLimitContinueCancel).toEqual({
        turnItemId,
        resetsAt
      })
    }
    if (reason === 'off') {
      enabled = false
      changed()
    }
    if (reason === 'sleep') {
      asleep = true
    }
    if (reason === 'message') {
      await current.host.send(REST_TEST_CALLER, restTestSend('new request'))
    }
    const send = vi.spyOn(current.host, 'send')
    current.clock.now = resetsAt + 15_000
    await current.host.usageLimitContinue.tick()
    expect(send).not.toHaveBeenCalled()
  }
)

it('retries refusals after 1, 2, 4 and 8 minutes and publishes failure after five attempts', async () => {
  const { current, sweep, resetsAt } = await setup()
  const send = vi.spyOn(current.host, 'send').mockResolvedValue({
    ok: false,
    refusal: refuse('execution_owner_reconciling', { reason: 'recordUnreadable' })
  })
  current.clock.now = resetsAt + 15_000
  await sweep.tick()
  for (const minutes of [1, 2, 4, 8]) {
    current.clock.now += minutes * 60_000 - 1
    await sweep.tick()
    const calls = send.mock.calls.length
    current.clock.now++
    await sweep.tick()
    expect(send.mock.calls.length).toBe(calls + 1)
  }
  expect(sweep.readState(SESSION)?.state).toBe('failed')
  current.clock.now += 60 * 60_000
  await sweep.tick()
  expect(send).toHaveBeenCalledTimes(5)
})

it('rechecks setting and cancellation under acceptance and reads unloaded journals without opening them', async () => {
  const { current, sweep, resetsAt } = await setup()
  const sessions = current.host.collaboratorsForTests().sessions
  const held = sessions.get(SESSION)!
  sessions.delete(SESSION)
  current.clock.now = resetsAt + 15_000
  const send = vi.spyOn(current.host, 'send').mockImplementation(async (_caller, params) => {
    enabled = false
    expect(() => params.beforeRun?.()).toThrow('agent_session_restart_work_superseded')
    return {
      ok: false,
      refusal: refuse('agent_session_operation_invalid', { reason: 'continuationSuperseded' })
    }
  })
  await sweep.tick()
  expect(send).toHaveBeenCalledOnce()
  expect(sessions.has(SESSION)).toBe(false)
  sessions.set(SESSION, held)
})
