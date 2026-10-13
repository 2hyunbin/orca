import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { AGENT_SESSION_BOUNDED_FRAMES_RUNTIME_CAPABILITY } from '../../../src/shared/structured-agent-session-surface-capabilities'
import { structuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined)
  }
}))

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

async function subscribeParams(boundedFrames: boolean | null): Promise<unknown> {
  const subscribe = vi.fn(() => () => undefined)
  const sendRequest = vi.fn(async () => ({ ok: true, result: {}, _meta: { runtimeId: 'r' } }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an RPC client stub with the two members the hook calls.
  const client = { sendRequest, subscribe } as unknown as RpcClient
  const hostSupport =
    boundedFrames === null
      ? null
      : structuredAgentSessionHostSupport(
          boundedFrames ? [AGENT_SESSION_BOUNDED_FRAMES_RUNTIME_CAPABILITY] : []
        )
  function Harness(): null {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook's options, of which this test supplies the ones it reads.
    useMobileStructuredAgentSession({
      client,
      sessionId: 'session-1',
      enabled: true,
      connected: true,
      agent: 'codex',
      hostSupport,
      onSendError: () => undefined
    } as never)
    return null
  }
  act(() => {
    renderer = create(createElement(Harness))
  })
  await vi.waitFor(() => expect(subscribe).toHaveBeenCalled())
  return subscribe.mock.calls[0]?.[1]
}

it('asks for bounded frames only from a host that advertises them, since older hosts refuse it', async () => {
  expect(await subscribeParams(true)).toEqual({ sessionId: 'session-1', boundedFrames: true })
  act(() => renderer?.unmount())
  expect(await subscribeParams(false)).toEqual({ sessionId: 'session-1' })
  act(() => renderer?.unmount())
  expect(await subscribeParams(null)).toEqual({ sessionId: 'session-1' })
})
