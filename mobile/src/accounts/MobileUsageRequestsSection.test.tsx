import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { MobileUsageRequestsSection } from './MobileUsageRequestsSection'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Switch: 'Switch',
  StyleSheet: { create: (value: unknown) => value }
}))

function reply(enabled: Record<string, boolean> = {}) {
  return {
    id: 'settings',
    ok: true as const,
    result: {
      settings: {
        usageRequestPolicyVersion: 1,
        usageRequestEnabled: enabled,
        antigravityUsageEnabled: false
      }
    }
  }
}
function clientWith(sendRequest: RpcClient['sendRequest']): RpcClient {
  return {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const mounted: ReactTestRenderer[] = []
afterEach(async () => {
  await act(async () => {
    mounted.splice(0).forEach((tree) => tree.unmount())
  })
})
async function mount(client: RpcClient, policyRevision = 1) {
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(
      createElement(MobileUsageRequestsSection, {
        client,
        connected: true,
        hostName: 'build-host',
        policyRevision
      })
    )
  })
  mounted.push(tree)
  return tree
}
function switchFor(tree: ReactTestRenderer, name: string) {
  return tree.root
    .findAll((node) => node.type === 'Switch')
    .find((node) => String(node.props.accessibilityLabel).startsWith(name))
}

describe('mobile host usage request controls', () => {
  it('shows unsupported host settings as unknown without false Off controls', async () => {
    const client = clientWith(async () => ({ id: 'old', ok: true, result: { settings: {} } }))
    const tree = await mount(client)
    expect(tree.root.findAll((node) => node.type === 'Switch')).toHaveLength(0)
    expect(JSON.stringify(tree.toJSON())).toContain('unknown')
  })

  it('keeps all ten host switches unchanged until matching readback, then receives a later host revision', async () => {
    const write = deferred<ReturnType<typeof reply>>()
    const send = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(reply())
      .mockReturnValueOnce(write.promise)
    const client = clientWith(send)
    const tree = await mount(client)
    expect(tree.root.findAll((node) => node.type === 'Switch')).toHaveLength(10)
    act(() => {
      switchFor(tree, 'Kimi')?.props.onValueChange(false)
    })
    expect(switchFor(tree, 'Kimi')?.props.value).toBe(true)
    expect(send).toHaveBeenLastCalledWith('settings.update', {
      usageRequestEnabled: { kimi: false }
    })
    await act(async () => {
      write.resolve(reply({ kimi: false }))
    })
    expect(switchFor(tree, 'Kimi')?.props.value).toBe(false)
    send.mockResolvedValueOnce(reply({ kimi: true }))
    await act(async () => {
      tree.update(
        createElement(MobileUsageRequestsSection, {
          client,
          connected: true,
          hostName: 'build-host',
          policyRevision: 2
        })
      )
    })
    expect(switchFor(tree, 'Kimi')?.props.value).toBe(true)
  })

  it('rejects stripped writes without presenting the requested Off state', async () => {
    const send = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(reply())
      .mockResolvedValueOnce({ id: 'stripped', ok: true, result: { settings: {} } })
    const tree = await mount(clientWith(send))
    await act(async () => {
      switchFor(tree, 'ZCode')?.props.onValueChange(false)
    })
    expect(tree.root.findAll((node) => node.type === 'Switch')).toHaveLength(0)
    expect(JSON.stringify(tree.toJSON())).toContain('unknown')
  })

  it('ignores a late write after changing clients', async () => {
    const write = deferred<ReturnType<typeof reply>>()
    const first = clientWith(
      vi
        .fn<RpcClient['sendRequest']>()
        .mockResolvedValueOnce(reply())
        .mockReturnValueOnce(write.promise)
    )
    const second = clientWith(async () => reply())
    const tree = await mount(first)
    act(() => {
      switchFor(tree, 'Claude')?.props.onValueChange(false)
    })
    await act(async () => {
      tree.update(
        createElement(MobileUsageRequestsSection, {
          client: second,
          connected: true,
          hostName: 'other-host'
        })
      )
    })
    await act(async () => {
      write.resolve(reply({ claude: false }))
    })
    expect(switchFor(tree, 'Claude')?.props.value).toBe(true)
  })
  it('keeps the acknowledged policy when a host revision read from during the write arrives late', async () => {
    const write = deferred<ReturnType<typeof reply>>()
    const staleRead = deferred<ReturnType<typeof reply>>()
    const send = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(reply({ claude: false }))
      .mockReturnValueOnce(write.promise)
      .mockReturnValueOnce(staleRead.promise)
      .mockResolvedValueOnce(reply({ claude: true }))
    const client = clientWith(send)
    const tree = await mount(client)
    act(() => {
      switchFor(tree, 'Claude')?.props.onValueChange(true)
    })
    await act(async () => {
      tree.update(
        createElement(MobileUsageRequestsSection, {
          client,
          connected: true,
          hostName: 'build-host',
          policyRevision: 2
        })
      )
    })
    await act(async () => {
      write.resolve(reply({ claude: true }))
    })
    await act(async () => {
      staleRead.resolve(reply({ claude: false }))
    })
    expect(switchFor(tree, 'Claude')?.props.value).toBe(true)
  })
  it('reconciles a delayed write reply instead of replacing a newer change from another client', async () => {
    const write = deferred<ReturnType<typeof reply>>()
    const reconciliation = deferred<ReturnType<typeof reply>>()
    const send = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(reply())
      .mockReturnValueOnce(write.promise)
      .mockResolvedValueOnce(reply({ claude: true }))
      .mockReturnValueOnce(reconciliation.promise)
      .mockResolvedValueOnce(reply({ claude: true }))
    const client = clientWith(send)
    const tree = await mount(client)
    act(() => {
      switchFor(tree, 'Claude')?.props.onValueChange(false)
    })
    await act(async () => {
      tree.update(
        createElement(MobileUsageRequestsSection, {
          client,
          connected: true,
          hostName: 'build-host',
          policyRevision: 2
        })
      )
    })
    await act(async () => {
      write.resolve(reply({ claude: false }))
    })
    expect(tree.root.findAll((node) => node.type === 'Switch')).toHaveLength(0)
    await act(async () => {
      tree.update(
        createElement(MobileUsageRequestsSection, {
          client,
          connected: true,
          hostName: 'build-host',
          policyRevision: 3
        })
      )
    })
    expect(switchFor(tree, 'Claude')?.props.value).toBe(true)
    await act(async () => {
      reconciliation.resolve(reply({ claude: false }))
    })
    expect(switchFor(tree, 'Claude')?.props.value).toBe(true)
  })
})
