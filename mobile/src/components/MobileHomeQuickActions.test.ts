import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '../transport/types'
import { MobileHomeQuickActions } from './MobileHomeQuickActions'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Plus: 'Plus',
  QrCode: 'QrCode'
}))

function host(id: string, name: string, endpoint: string): HostProfile {
  return {
    id,
    name,
    endpoint,
    deviceToken: `token-${id}`,
    publicKeyB64: `key-${id}`,
    lastConnected: 1
  }
}

describe('MobileHomeQuickActions', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  async function renderQuickActions(connectedHosts: HostProfile[]) {
    const onPairDesktop = vi.fn()
    const onCreateWorkspace = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
        throw new Error(String(args[0]))
      }
    })
    await act(async () => {
      renderer = create(
        createElement(MobileHomeQuickActions, { connectedHosts, onPairDesktop, onCreateWorkspace })
      )
    })
    consoleError.mockRestore()
    return { onCreateWorkspace }
  }

  function newWorkspaceButton() {
    return renderer!.root.findAllByType('Pressable')[1]
  }

  it('disables workspace creation without a connected host', async () => {
    await renderQuickActions([])

    expect(newWorkspaceButton().props.disabled).toBe(true)
    expect(newWorkspaceButton().props.accessibilityState).toEqual({ disabled: true })
  })

  it('starts workspace creation, leaving the choice of desktop to the overlay it opens', async () => {
    const callbacks = await renderQuickActions([
      host('desk', 'Desk', 'ws://192.168.1.2:6768'),
      host('laptop', 'Laptop', 'wss://relay.example.com/mobile')
    ])

    act(() => newWorkspaceButton().props.onPress())

    expect(callbacks.onCreateWorkspace).toHaveBeenCalledTimes(1)
  })
})
