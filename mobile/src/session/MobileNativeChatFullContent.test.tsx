import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'
import { MobileNativeChatItemSourceContext } from './mobile-native-chat-item-read'
import { useMobileNativeChatFullMessage } from './MobileNativeChatFullContent'

vi.mock('react-native', () => ({
  Pressable: 'Pressable', Text: 'Text', View: 'View',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
const message: NativeChatMessage = { id: 'message', role: 'assistant', source: 'transcript', timestamp: 1, shortened: true, blocks: [{ type: 'text', text: 'head' }] }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only client identity is used; this fixture performs no RPC.
const first = {} as RpcClient
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only client identity is used; this fixture performs no RPC.
const second = {} as RpcClient
let renderer: ReactTestRenderer | undefined
afterEach(() => { act(() => renderer?.unmount()) })
function Probe() { return useMobileNativeChatFullMessage(message).showFull }

it.each(['client', 'session'] as const)('keeps a pending or failed request with its original %s owner', async (changed) => {
  const pending = Promise.withResolvers<void>()
  const oldLoad = vi.fn(() => pending.promise)
  const newLoad = vi.fn(async () => {})
  const source = (client: RpcClient, sessionId: string, load: () => Promise<void>) => ({
    client, sessionId, messageDetail: { raw: () => message, state: () => 'available' as const, load }
  })
  const render = (value: ReturnType<typeof source>) => createElement(MobileNativeChatItemSourceContext.Provider, { value }, createElement(Probe))
  await act(async () => { renderer = create(render(source(first, 'session', oldLoad))) })
  const button = () => renderer?.root.findByProps({ accessibilityRole: 'button' })
  await act(async () => { button()?.props.onPress() })
  expect(button()?.props.disabled).toBe(true)
  await act(async () => { renderer?.update(render(source(changed === 'client' ? second : first, changed === 'session' ? 'other' : 'session', newLoad))) })
  expect(button()?.props.disabled).toBe(false)
  await act(async () => { pending.reject(new Error('old host failed')); await pending.promise.catch(() => {}) })
  expect(JSON.stringify(renderer?.toJSON())).not.toContain("couldn't load")
  await act(async () => { button()?.props.onPress() })
  expect(newLoad).toHaveBeenCalledOnce()
})
