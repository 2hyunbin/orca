import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredSendChoice } from './use-mobile-structured-send-choice'

it('offers a choice only for a verified injecting agent on the current connection', async () => {
  let generation = 0
  const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue({
    id: 'agents',
    ok: true,
    result: {
      agents: [
        { agent: 'codex', capabilities: { steering: 'inject' } },
        { agent: 'acp:plain', capabilities: { steering: 'queue' } }
      ]
    },
    _meta: { runtimeId: 'host-1' }
  })
  const client: RpcClient = {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getGeneration: () => generation,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  let supported = false
  function Harness({ enabled = true, agent = 'codex' }) {
    supported = useMobileStructuredSendChoice({ client, agent, enabled })
    return null
  }
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  try {
    expect(supported).toBe(true)
    await act(async () => renderer.update(createElement(Harness, { agent: 'acp:plain' })))
    expect(supported).toBe(false)
    sendRequest.mockRejectedValue(new Error('old host has no agent list'))
    generation += 1
    await act(async () => renderer.update(createElement(Harness)))
    expect(supported).toBe(false)
    await act(async () => renderer.update(createElement(Harness, { enabled: false })))
    expect(supported).toBe(false)
    await act(async () => renderer.update(createElement(Harness)))
    expect(supported).toBe(false)
  } finally {
    act(() => renderer.unmount())
  }
})
