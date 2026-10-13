import { expect, it, vi } from 'vitest'
import { AgentSessionAcquisitionRefusal } from './structured-agent-session-adapter'
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
  reportedOptions: { model: 'gpt-test' },
  restoreSkippedOptions: [],
  optionRevision: -1
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
