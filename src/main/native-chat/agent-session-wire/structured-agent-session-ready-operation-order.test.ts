import { expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  CALLER,
  attach,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

it.each(['send', 'compact'] as const)(
  'answers an accepted %s receipt during an unconfirmed rewind without starting an agent',
  async (command) => {
    const { host, store, acquire, dispatch } = hostTestState()
    const compact = vi.fn(async () => ({ state: 'admitted' as const }))
    host.deps.adapter.compact = compact
    const providerWrites = command === 'send' ? dispatch : compact
    await attach()
    const body = hostTestMessage('already accepted')
    const params = {
      envelope: envelope(
        command === 'send' ? 'agentSession.send' : 'agentSession.conversationCommand',
        command === 'send' ? { body } : { command: 'compact' }
      ),
      body,
      command: 'compact' as const
    }
    const run = (caller = CALLER) =>
      command === 'send' ? host.send(caller, params) : host.conversationCommand(caller, params)
    expect(await run()).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(providerWrites).toHaveBeenCalledTimes(1))
    await host.close(SESSION, 'evict')
    const expectedEpoch = (await host.journalSnapshot(SESSION)).cursor.epoch
    await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      rewind: {
        operationId: envelope('agentSession.rewind', {}).clientOperationId,
        callerKey: CALLER.callerKey,
        itemId: agentJournalSubmissionKey(params.envelope.clientOperationId),
        providerItemId: 'codex:thread-1:turn-1:1',
        expectedEpoch,
        phase: 'prepared',
        retained: []
      }
    }))
    acquire.mockRejectedValueOnce(new Error('restart failed'))

    expect(await run({ callerKey: 'reconnecting-phone' })).toMatchObject({
      ok: true,
      replayed: true
    })
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(providerWrites).toHaveBeenCalledTimes(1)
  }
)
it.each(['goal', 'rewind'] as const)(
  'runs a %s on a ready child before a later send is accepted',
  async (operation) => {
    const { host, dispatch } = hostTestState()
    await attach()
    const body = hostTestMessage('first turn')
    const first = { envelope: envelope('agentSession.send', { body }), body }
    expect(await host.send(CALLER, first)).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    await host.flushStreamedEvents(SESSION)
    const order: string[] = []
    host.deps.adapter.changeThreadGoal = vi.fn(async () => {
      order.push('goal')
      return { ok: true as const }
    })
    host.deps.adapter.rewindSupport = () => ({ supported: true })
    host.deps.adapter.rewind = vi.fn(async () => {
      order.push('rewind')
      return { ok: false as const, reason: 'history-not-paginated' as const }
    })
    const itemId = agentJournalSubmissionKey(first.envelope.clientOperationId)
    const expectedEpoch = (await host.journalSnapshot(SESSION)).cursor.epoch
    const change = { kind: 'set' as const, objective: 'Apply before the message' }
    const blocked = Promise.withResolvers<void>()
    void host.collaboratorsForTests().serialize(SESSION, () => blocked.promise)
    const requested =
      operation === 'goal'
        ? host.changeThreadGoal(CALLER, {
            envelope: envelope('agentSession.threadGoal', { change }),
            change
          })
        : host.rewind(CALLER, {
            envelope: envelope('agentSession.rewind', { itemId, expectedEpoch }),
            itemId,
            expectedEpoch
          })
    const laterBody = hostTestMessage('later message')
    const sent = host.send(CALLER, {
      envelope: envelope('agentSession.send', { body: laterBody }),
      body: laterBody,
      beforeRun: () => order.push('send')
    })
    blocked.resolve()

    const result = await requested
    expect(result).toMatchObject(
      operation === 'goal'
        ? { ok: true }
        : { ok: false, refusal: { rewindReason: 'history-not-paginated' } }
    )
    expect(await sent).toMatchObject({ ok: true })
    expect(order).toEqual([operation, 'send'])
  }
)
