import { afterEach, describe, expect, it } from 'vitest'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import {
  closePiRpcAdapterFixtures,
  restart,
  sessionId,
  setup,
  state
} from './rpc-session-adapter.test-fixture'

afterEach(closePiRpcAdapterFixtures)

describe('Pi host awaited open', () => {
  it('owns the process before RPC and restores model before effort during open', async () => {
    const h = await setup()
    const stateReply = Promise.withResolvers<unknown>()
    const { acquired, child } = await restart(
      h,
      (connection) => {
        connection.requestOverride = (command) =>
          command === 'get_state' && connection.requests.length === 1
            ? stateReply.promise
            : command === 'set_thinking_level'
              ? Promise.resolve({})
              : undefined
      },
      { options: { model: 'anthropic/model-2', effort: 'high' } }
    )
    expect(child.requests).toEqual([])
    expect(acquired.process.pid).toBe(4123)
    const opening = h.adapter.open({
      sessionId,
      fence: 8,
      acquisitionGeneration: acquired.acquisitionGeneration ?? null,
      signal: new AbortController().signal
    })
    expect(child.requests).toEqual(['get_state'])
    stateReply.resolve(state)
    await expect(opening).resolves.toMatchObject({
      reportedOptions: { model: 'anthropic/model-1' }
    })
    expect(child.requests.indexOf('set_model')).toBeLessThan(
      child.requests.indexOf('set_thinking_level')
    )
    expect(h.lifecycle).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'started' }))
  })

  it('rejects a known empty listing once, then opens a fresh child after sign-in', async () => {
    const h = await setup()
    const { acquired, child } = await restart(h, (connection) => {
      connection.requestOverride = (command) =>
        command === 'get_available_models' ? Promise.resolve({ models: [] }) : undefined
    })
    await expect(
      h.adapter.open({
        sessionId,
        fence: 8,
        acquisitionGeneration: acquired.acquisitionGeneration ?? null,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ reason: 'notSignedIn' })
    expect(child.closed).toBe(false)
    expect(child.sent).toEqual([])
    await h.adapter.closeSession(sessionId)
    const again = await h.adapter.acquire({ ...h.input, fence: 9 })
    await expect(
      h.adapter.open({
        sessionId,
        fence: 9,
        acquisitionGeneration: again.acquisitionGeneration ?? null,
        signal: new AbortController().signal
      })
    ).resolves.toMatchObject({ reportedOptions: { model: 'anthropic/model-1' } })
    expect(h.connections).toHaveLength(3)
  })

  it('treats an unknown provider as signed out even when listing succeeds', async () => {
    const h = await setup()
    const { acquired, child } = await restart(h, (connection) => {
      connection.requestOverride = (command) =>
        command === 'get_state'
          ? Promise.resolve({ ...state, model: { provider: 'unknown', id: 'unknown' } })
          : undefined
    })
    await expect(
      h.adapter.open({
        sessionId,
        fence: 8,
        acquisitionGeneration: acquired.acquisitionGeneration ?? null,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ reason: 'notSignedIn' })
    expect(child.requests).toEqual(['get_state'])
  })

  it('keeps a failed optional listing distinct from a known empty list', async () => {
    const h = await setup()
    const { acquired } = await restart(h, (connection) => {
      connection.requestOverride = (command) =>
        command === 'get_available_models'
          ? Promise.reject(new JsonlRpcResponseError(command, 'listing unavailable'))
          : undefined
    })
    await expect(
      h.adapter.open({
        sessionId,
        fence: 8,
        acquisitionGeneration: acquired.acquisitionGeneration ?? null,
        signal: new AbortController().signal
      })
    ).resolves.toMatchObject({ reportedOptions: { model: 'anthropic/model-1' } })
  })

  it('lets the host close a child held in the state request without a late open', async () => {
    const h = await setup()
    const stateReply = Promise.withResolvers<unknown>()
    const { acquired, child } = await restart(h, (connection) => {
      connection.requestOverride = (command) =>
        command === 'get_state' ? stateReply.promise : undefined
      connection.abortRequest = () => stateReply.reject(new Error('closed while starting'))
    })
    const controller = new AbortController()
    const opening = h.adapter
      .open({
        sessionId,
        fence: 8,
        acquisitionGeneration: acquired.acquisitionGeneration ?? null,
        signal: controller.signal
      })
      .catch((error: unknown) => error)
    expect(child.requests).toEqual(['get_state'])
    controller.abort()
    await h.adapter.closeSession(sessionId)
    expect(await opening).toBeInstanceOf(Error)
    expect(child.rootVerdict).toBe('exited')
    expect(h.lifecycle).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'started' }))
  })
})
