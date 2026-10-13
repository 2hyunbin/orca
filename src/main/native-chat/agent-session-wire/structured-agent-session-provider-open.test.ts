import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { expect, it, vi } from 'vitest'
import { AgentSessionAcquisitionRefusal } from './structured-agent-session-adapter'
import type {
  StructuredAgentSessionProviderOpen,
  StructuredAgentSessionProviderOpenResult
} from './structured-agent-session-provider-open-contract'
import {
  CALLER,
  attach,
  attachParams,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

const OPENED: StructuredAgentSessionProviderOpenResult = {
  reportedOptions: { model: 'gpt-test' },
  restoreSkippedOptions: []
}

function awaitOpen() {
  const state = hostTestState()
  const acquire = state.acquire.getMockImplementation()
  if (!acquire) {
    throw new Error('The host fixture has no spawn implementation.')
  }
  state.host.deps.adapter.acquire = async (input) => ({
    ...(await acquire(input)),
    providerChildPhase: 'starting',
    acquisitionGeneration: 'awaited-open'
  })
  const pending = Promise.withResolvers<StructuredAgentSessionProviderOpenResult>()
  const open = vi.fn<StructuredAgentSessionProviderOpen>(() => pending.promise)
  const close = vi.fn(async () => true)
  state.host.deps.adapter.open = open
  state.host.deps.adapter.closeSession = close
  const send = (text: string) => {
    const body = hostTestMessage(text)
    return state.host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  }
  return { ...state, open, close, pending, send }
}

it('accepts messages and reads while one host-awaited open holds delivery', async () => {
  const { host, open, dispatch, pending, send } = awaitOpen()
  await attach()
  expect(open).toHaveBeenCalledTimes(1)
  expect(await send('first')).toMatchObject({
    ok: true,
    value: { submission: { dispatchState: 'pending' } }
  })
  expect(await send('second')).toMatchObject({
    ok: true,
    value: { submission: { dispatchState: 'pending' } }
  })
  expect((await host.journalSnapshot(SESSION)).submissions).toHaveLength(2)
  expect(dispatch).not.toHaveBeenCalled()

  pending.resolve(OPENED)
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
  expect(open).toHaveBeenCalledTimes(1)
})

it('closes a refused open once and records one provider failure for all held messages', async () => {
  const { host, open, close, dispatch, pending, send } = awaitOpen()
  await attach()
  await send('first')
  await send('second')
  pending.reject(new AgentSessionAcquisitionRefusal('Sign in to the provider.', 'notSignedIn'))

  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
  const snapshot = await host.journalSnapshot(SESSION)
  expect(snapshot.submissions).toHaveLength(2)
  expect(snapshot.submissions.every((entry) => entry.dispatchState === 'rejected')).toBe(true)
  expect(snapshot.submissions.every((entry) => entry.rejection?.kind === 'notSignedIn')).toBe(true)
  expect(
    snapshot.items.filter(
      (item) => item.body.kind === 'status' && item.body.failure?.kind === 'notSignedIn'
    )
  ).toHaveLength(1)
  expect(open).toHaveBeenCalledTimes(1)
  expect(dispatch).not.toHaveBeenCalled()
})

it('records a refused owned open even before a message is accepted', async () => {
  const { host, close, pending, dispatch } = awaitOpen()
  await attach()
  pending.reject(new AgentSessionAcquisitionRefusal('Sign in to the provider.', 'notSignedIn'))
  await vi.waitFor(async () => {
    const snapshot = await host.journalSnapshot(SESSION)
    expect(snapshot.submissions).toEqual([])
    expect(
      snapshot.items.filter(
        (item) => item.body.kind === 'status' && item.body.failure?.kind === 'notSignedIn'
      )
    ).toHaveLength(1)
  })
  expect(close).toHaveBeenCalledTimes(1)
  expect(dispatch).not.toHaveBeenCalled()
})

it('closes a child while its open is pending and refuses its late readiness result', async () => {
  const { host, open, close, dispatch, pending, send } = awaitOpen()
  await attach()
  await send('held')
  await host.close(SESSION, 'user-close')
  expect(close).toHaveBeenCalledTimes(1)
  expect(open.mock.calls[0]?.[0].signal.aborted).toBe(true)

  pending.resolve(OPENED)
  await host.flushAllStreamedEvents()
  expect(dispatch).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledTimes(1)
})

it('ends the host open wait when the matching child exits without answering', async () => {
  const { host, open, dispatch, send } = awaitOpen()
  const attached = await attach()
  if (!attached) {
    throw new Error('The spawned child has no owner record.')
  }
  await send('held')
  await host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    fence: attached.lease.runtimeFence,
    acquisitionGeneration: 'awaited-open',
    reason: 'The provider exited before answering.',
    cause: 'unexpected-exit'
  })
  expect(open.mock.calls[0]?.[0].signal.aborted).toBe(true)
  await vi.waitFor(async () => {
    const snapshot = await host.journalSnapshot(SESSION)
    expect(snapshot.submissions[0]?.dispatchState).toBe('rejected')
  })
  expect(dispatch).not.toHaveBeenCalled()
})

it.each(['close', 'quit'] as const)(
  'cancels the open on %s after a second client attach is refused',
  async (ending) => {
    const { host, open, close, dispatch, pending, send } = awaitOpen()
    await attach()
    await send('held')
    expect(await host.attach({ callerKey: 'second-client' }, attachParams())).toMatchObject({
      ok: false
    })
    const ended =
      ending === 'quit'
        ? host.flushAllStreamedEvents({ trigger: 'quit' })
        : host.close(SESSION, 'user-close')
    try {
      await vi.waitFor(() => expect(open.mock.calls[0]?.[0].signal.aborted).toBe(true))
      await ended
      expect(close).toHaveBeenCalledTimes(1)
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      pending.resolve(OPENED)
      await ended
    }
  }
)

it('runs a goal requested during opening before a message sent later', async () => {
  const { host, pending, dispatch, send } = awaitOpen()
  await attach()
  const order: string[] = []
  host.deps.adapter.changeThreadGoal = vi.fn(async () => {
    order.push('goal')
    return { ok: true as const }
  })
  const originalDispatch = dispatch.getMockImplementation()
  dispatch.mockImplementation(async (input) => {
    order.push('send')
    if (!originalDispatch) {
      throw new Error('Missing dispatch implementation')
    }
    return originalDispatch(input)
  })
  const change = { kind: 'set' as const, objective: 'Requested before the message' }
  const goal = host.changeThreadGoal(CALLER, {
    envelope: envelope('agentSession.threadGoal', { change }),
    change
  })
  await host.collaboratorsForTests().serialize(SESSION, async () => {})
  const later = send('later message')
  let accepted = false
  void later.then(() => {
    accepted = true
  })
  try {
    await vi.waitFor(() => expect(accepted).toBe(true))
    expect(dispatch).not.toHaveBeenCalled()
  } finally {
    pending.resolve(OPENED)
  }
  expect(await goal).toMatchObject({ ok: true })
  expect(await later).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(order).toHaveLength(2))
  expect(order).toEqual(['goal', 'send'])
})

it.each(['stop', 'close'] as const)(
  'cancels a startup rewind history read on %s and ignores its late result',
  async (ending) => {
    const { host, store, pending, close, dispatch } = awaitOpen()
    await attach()
    const expectedEpoch = (await host.journalSnapshot(SESSION)).cursor.epoch
    await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      rewind: {
        operationId: envelope('agentSession.rewind', {}).clientOperationId,
        callerKey: CALLER.callerKey,
        itemId: 'codex:thread-1:turn-1:1',
        providerItemId: 'codex:thread-1:turn-1:1',
        expectedEpoch,
        phase: 'prepared',
        retained: []
      }
    }))
    const recovery = Promise.withResolvers<{ ok: true; items: [] }>()
    const recover = vi.fn(() => recovery.promise)
    host.deps.adapter.recoverRewind = recover
    pending.resolve(OPENED)
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce())
    const ended =
      ending === 'close'
        ? host.close(SESSION, 'user-close')
        : host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
    try {
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
      await ended
      expect(store.getRecord(SESSION)?.rewind?.phase).toBe('prepared')
    } finally {
      recovery.resolve({ ok: true, items: [] })
      await ended
      await host.flushAllStreamedEvents()
    }
    expect(dispatch).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.rewind?.phase).toBe('prepared')
  }
)

it('saves startup picks and writes running picks to the live child', async () => {
  const { host, store, pending, setOption } = awaitOpen()
  await attach()
  for (const model of ['model-before-ready', 'model-after-ready']) {
    expect(
      await host.setOption(CALLER, {
        envelope: envelope('agentSession.setOption', { key: 'model', value: model }),
        key: 'model',
        value: model
      })
    ).toMatchObject({ ok: true })
    expect(store.getRecord(SESSION)?.options?.model).toBe(model)
    expect(setOption).toHaveBeenCalledTimes(model === 'model-before-ready' ? 0 : 1)
    pending.resolve(OPENED)
    await vi.waitFor(() =>
      expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready')
    )
  }
  expect(store.getRecord(SESSION)?.options?.model).toBe('model-after-ready')
})

it.each([false, true])(
  'delivers a later message after a startup rewind (success: %s)',
  async (succeeds) => {
    const { host, open, dispatch, pending, send } = awaitOpen()
    await attach()
    pending.resolve(OPENED)
    await vi.waitFor(() =>
      expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready')
    )
    await send('previous turn')
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    await host.flushStreamedEvents(SESSION)
    const previous = (await host.journalSnapshot(SESSION)).submissions[0]
    if (!previous) {
      throw new Error('Missing previous turn')
    }
    await host.close(SESSION, 'evict')
    const reopened = Promise.withResolvers<StructuredAgentSessionProviderOpenResult>()
    open.mockImplementationOnce(() => reopened.promise)
    await host.attach(CALLER, attachParams())
    const order: string[] = []
    const originalDispatch = dispatch.getMockImplementation()
    dispatch.mockImplementation(async (input) => {
      order.push('send')
      if (!originalDispatch) {
        throw new Error('Missing dispatch implementation')
      }
      return originalDispatch(input)
    })
    host.deps.adapter.rewindSupport = () => ({ supported: true })
    host.deps.adapter.rewind = vi.fn(async () => {
      order.push('rewind')
      return succeeds
        ? { ok: true as const, items: [] }
        : { ok: false as const, reason: 'history-not-paginated' as const }
    })
    const itemId = agentJournalSubmissionKey(previous.clientMessageId)
    const expectedEpoch = (await host.journalSnapshot(SESSION)).cursor.epoch
    const rewind = host.rewind(CALLER, {
      envelope: envelope('agentSession.rewind', { itemId, expectedEpoch }),
      itemId,
      expectedEpoch
    })
    await host.collaboratorsForTests().serialize(SESSION, async () => {})
    const later = send('later message')
    let accepted = false
    void later.then(() => {
      accepted = true
    })
    try {
      await vi.waitFor(() => expect(accepted).toBe(true))
      expect(order).toEqual([])
    } finally {
      reopened.resolve(OPENED)
    }
    expect(await rewind).toMatchObject(
      succeeds
        ? { ok: true }
        : {
            ok: false,
            refusal: { rewindReason: 'history-not-paginated' }
          }
    )
    expect(await later).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(order).toHaveLength(2))
    expect(order).toEqual(['rewind', 'send'])
  }
)

it('delivers two earlier sends before a later goal, then the send after that goal', async () => {
  const { host, pending, dispatch, send } = awaitOpen()
  await attach()
  const order: string[] = []
  const originalDispatch = dispatch.getMockImplementation()
  if (!originalDispatch) {
    throw new Error('Missing dispatch implementation')
  }
  dispatch.mockImplementation(async (input) => {
    const { body } = input
    order.push(body.blocks[0]?.type === 'text' ? body.blocks[0].text : 'send')
    return originalDispatch(input)
  })
  host.deps.adapter.changeThreadGoal = vi.fn(async () => {
    order.push('goal')
    return { ok: true as const }
  })
  await send('first')
  await send('second')
  const change = { kind: 'set' as const, objective: 'After the first two messages' }
  const goal = host.changeThreadGoal(CALLER, {
    envelope: envelope('agentSession.threadGoal', { change }),
    change
  })
  await host.collaboratorsForTests().serialize(SESSION, async () => {})
  const later = send('third')
  pending.resolve(OPENED)
  expect(await goal).toMatchObject({ ok: true })
  expect(await later).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(order).toHaveLength(4))
  expect(order).toEqual(['first', 'second', 'goal', 'third'])
})
