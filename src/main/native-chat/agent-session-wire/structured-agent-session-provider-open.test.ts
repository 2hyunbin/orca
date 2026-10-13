import { expect, it, vi } from 'vitest'
import type {
  StructuredAgentSessionProviderOpen,
  StructuredAgentSessionProviderOpenResult
} from './structured-agent-session-provider-open-contract'
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

it('writes both startup and running picks to the live child', async () => {
  const { host, store, pending, setOption } = awaitOpen()
  await attach()
  for (const model of ['model-before-ready', 'model-after-ready']) {
    const picked = host.setOption(CALLER, {
      envelope: envelope('agentSession.setOption', { key: 'model', value: model }),
      key: 'model',
      value: model
    })
    pending.resolve(OPENED)
    expect(await picked).toMatchObject({ ok: true })
    expect(store.getRecord(SESSION)?.options?.model).toBe(model)
    expect(setOption).toHaveBeenCalledTimes(model === 'model-before-ready' ? 1 : 2)
    await vi.waitFor(() =>
      expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready')
    )
  }
  expect(store.getRecord(SESSION)?.options?.model).toBe('model-after-ready')
})

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
