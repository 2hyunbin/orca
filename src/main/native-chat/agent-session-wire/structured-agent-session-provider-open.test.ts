import { expect, it, vi } from 'vitest'
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
  reportedOptions: { model: 'gpt-test' }
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

it('cancels the open on quit after a second client attach is refused', async () => {
  const { host, open, close, dispatch, pending, send } = awaitOpen()
  await attach()
  await send('held')
  expect(await host.attach({ callerKey: 'second-client' }, attachParams())).toMatchObject({
    ok: false
  })
  const ended = host.flushAllStreamedEvents({ trigger: 'quit' })
  try {
    await vi.waitFor(() => expect(open.mock.calls[0]?.[0].signal.aborted).toBe(true))
    await ended
    expect(close).toHaveBeenCalledTimes(1)
    expect(dispatch).not.toHaveBeenCalled()
  } finally {
    pending.resolve(OPENED)
    await ended
  }
})
