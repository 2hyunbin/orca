import { afterEach, describe, expect, it } from 'vitest'
import {
  closePiRpcAdapterFixtures,
  file,
  restart,
  sessionId,
  setup,
  state
} from './rpc-session-adapter.test-fixture'

afterEach(closePiRpcAdapterFixtures)

describe('Pi host awaited open', () => {
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

  it('fails an open if its lane fails while the state request is pending', async () => {
    const h = await setup()
    const stateReply = Promise.withResolvers<unknown>()
    const { acquired, child } = await restart(h, (connection) => {
      connection.requestOverride = (command) =>
        command === 'get_state' ? stateReply.promise : undefined
    })
    const opening = h.adapter.open({
      sessionId,
      fence: 8,
      acquisitionGeneration: acquired.acquisitionGeneration ?? null,
      signal: new AbortController().signal
    })
    child.handlers.onClose?.(new Error('lane failed during startup'))
    stateReply.resolve(state)
    await expect(opening).rejects.toThrow('lane failed during startup')
  })

  it('teaches the account default only from a new session started with no pick', async () => {
    const h = await setup()
    expect(h.started.catalogListing?.configuredDefault).toEqual({
      modelId: 'anthropic/model-1',
      effort: null
    })

    h.resolveLaunch.mockResolvedValueOnce({ ...(await h.resolveLaunch()), sessionFile: file })
    const { acquired } = await restart(h, () => {})
    const resumed = await h.adapter.open({
      sessionId,
      fence: 8,
      acquisitionGeneration: acquired.acquisitionGeneration ?? null,
      signal: new AbortController().signal
    })
    expect(resumed.catalogListing).toBeDefined()
    expect(resumed.catalogListing).not.toHaveProperty('configuredDefault')
  })
})
