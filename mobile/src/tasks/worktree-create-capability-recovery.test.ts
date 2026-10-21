import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { useNewWorktreeRuntimeCapabilities } from './worktree-create-capability'

function connection() {
  let generation = 1
  const client = new FakeSession('connected')
  client.getLastConnectedAt = () => generation
  client.sendRequest.mockResolvedValue({
    id: 'status',
    ok: true,
    result: { capabilities: ['mobile.tasks.v1', 'worktree.create-idempotency.v1'] },
    _meta: { runtimeId: 'test' }
  })
  return {
    client,
    sendRequest: client.sendRequest,
    reconnect() {
      generation += 1
      client.publishState('connected')
    }
  }
}

describe('capability probe recovery', () => {
  let renderer: ReactTestRenderer | undefined
  let current: ReturnType<typeof useNewWorktreeRuntimeCapabilities> | undefined
  function Harness({ client, enabled }: { client: RpcClient; enabled: boolean }) {
    current = useNewWorktreeRuntimeCapabilities(client, enabled)
    return null
  }
  async function render(client: RpcClient, enabled = true) {
    await act(async () => {
      const element = createElement(Harness, { client, enabled })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  }
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = undefined
    vi.useRealTimers()
  })

  it('retries a transient failure when the create sheet reopens on the same client', async () => {
    const host = connection()
    host.sendRequest.mockRejectedValueOnce(new Error('offline'))
    await render(host.client)
    expect(current?.tasksSupported).toBe(false)
    await render(host.client, false)
    await render(host.client)
    expect(current?.tasksSupported).toBe(true)
    await expect(current?.getWorktreeCreateCutoverSupport()).resolves.toBeTruthy()
  })

  it('recovers Tasks without requiring a sheet reopen', async () => {
    vi.useFakeTimers()
    const host = connection()
    host.sendRequest.mockRejectedValueOnce(new Error('timeout'))
    await render(host.client)
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(current?.tasksSupported).toBe(true)
  })

  it('does not publish a retired client probe after switching to a disabled host', async () => {
    const first = connection()
    const second = connection()
    let resolve: ((value: Awaited<ReturnType<typeof first.sendRequest>>) => void) | undefined
    first.sendRequest.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    await render(first.client)
    await render(second.client, false)
    await act(async () =>
      resolve?.({
        id: 'late',
        ok: true,
        result: { capabilities: ['mobile.tasks.v1'] },
        _meta: { runtimeId: 'retired' }
      })
    )
    expect(current?.tasksSupported).toBe(false)
    expect(current?.hostPlatform).toBeNull()
    expect(second.sendRequest).not.toHaveBeenCalled()
  })

  it('reprobes after reconnect while keeping confirmed old hosts conservative', async () => {
    const host = connection()
    host.sendRequest.mockResolvedValueOnce({
      id: 'status',
      ok: true,
      result: { capabilities: [] },
      _meta: { runtimeId: 'old' }
    })
    await render(host.client)
    await expect(current?.getWorktreeCreateCutoverSupport()).resolves.toBe(false)
    expect(host.sendRequest).toHaveBeenCalledTimes(1)
    await act(async () => host.reconnect())
    expect(current?.tasksSupported).toBe(true)
    expect(host.sendRequest).toHaveBeenCalledTimes(2)
  })
})
