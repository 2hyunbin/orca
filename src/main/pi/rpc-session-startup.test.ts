import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closePiRpcAdapterFixtures,
  file,
  reportedEvent,
  restart,
  sessionId,
  setup,
  state
} from './rpc-session-adapter.test-fixture'

function openAt8(h: Awaited<ReturnType<typeof setup>>, acquisitionGeneration: string) {
  return h.adapter.open({
    sessionId,
    fence: 8,
    acquisitionGeneration,
    signal: new AbortController().signal
  })
}

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

  it('is ready once Pi reports its state; the listing follows, and an empty one fails nothing', async () => {
    const h = await setup()
    const listing = Promise.withResolvers<unknown>()
    const { acquired, child } = await restart(h, (connection) => {
      connection.requestOverride = (command) =>
        command === 'get_available_models' ? listing.promise : undefined
    })
    await expect(openAt8(h, acquired.acquisitionGeneration)).resolves.toMatchObject({
      reportedOptions: { model: 'anthropic/model-1' }
    })
    expect(h.lifecycle).not.toHaveBeenCalled()
    listing.resolve({ models: [] })
    await vi.waitFor(() => expect(reportedEvent(h.lifecycle, 'options-reported').fence).toBe(8))
    expect(child.closed).toBe(false)
    await vi.waitFor(() =>
      expect(h.adapter.readCommands(sessionId)).toMatchObject([{ name: 'help' }])
    )
  })

  it('fails the start when Pi runs the unknown provider', async () => {
    const h = await setup()
    const unknown = { ...state, model: { provider: 'unknown', id: 'unknown' } }
    const { acquired } = await restart(h, (connection) => {
      connection.requestOverride = (command) =>
        command === 'get_state' ? Promise.resolve(unknown) : undefined
    })
    await expect(openAt8(h, acquired.acquisitionGeneration)).rejects.toMatchObject({
      reason: 'notSignedIn'
    })
  })

  it('teaches the account default only from a new session started with no pick', async () => {
    const h = await setup()
    await vi.waitFor(() =>
      expect(
        reportedEvent(h.lifecycle, 'options-reported').catalogListing?.configuredDefault
      ).toEqual({ modelId: 'anthropic/model-1', effort: null })
    )

    h.resolveLaunch.mockResolvedValueOnce({ ...(await h.resolveLaunch()), sessionFile: file })
    const { acquired } = await restart(h, () => {})
    await openAt8(h, acquired.acquisitionGeneration)
    await vi.waitFor(() =>
      expect(reportedEvent(h.lifecycle, 'options-reported').catalogListing).toBeDefined()
    )
    expect(reportedEvent(h.lifecycle, 'options-reported').catalogListing).not.toHaveProperty(
      'configuredDefault'
    )
  })
})
