import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { usePhonePresenceReport } from './use-phone-presence-report'

const lifecycle = vi.hoisted(() => ({
  appState: 'active',
  listeners: new Set<(state: string) => void>()
}))

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return lifecycle.appState
    },
    addEventListener(_event: string, listener: (state: string) => void) {
      lifecycle.listeners.add(listener)
      return { remove: () => lifecycle.listeners.delete(listener) }
    }
  }
}))

vi.mock('../../../src/shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const AWAY = { workspaceIds: [], tabIds: [], presentForMs: 0 }
const BACK = { workspaceIds: [], tabIds: [], presentForMs: null }

function harness(connState: ConnectionState = 'connected') {
  const sendRequest = vi.fn(async (_method: string, _params: unknown) => ({ ok: true }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook calls only sendRequest.
  const client = { sendRequest } as unknown as RpcClient
  function Probe(props: { state: ConnectionState }) {
    usePhonePresenceReport(client, props.state)
    return null
  }
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(createElement(Probe, { state: connState }))
  })
  return {
    sendRequest,
    reports: () => sendRequest.mock.calls.map(([, params]) => params),
    setConnState: (state: ConnectionState) =>
      act(() => renderer.update(createElement(Probe, { state }))),
    unmount: () => act(() => renderer.unmount())
  }
}

function changeAppState(state: string): void {
  lifecycle.appState = state
  act(() => {
    for (const listener of lifecycle.listeners) {
      listener(state)
    }
  })
}

afterEach(() => {
  lifecycle.appState = 'active'
  lifecycle.listeners.clear()
})

describe('usePhonePresenceReport', () => {
  it('reports away when the app leaves the foreground and back when it returns', () => {
    const h = harness()
    expect(h.sendRequest).toHaveBeenLastCalledWith('sidebarInputs.reportView', BACK)
    changeAppState('background')
    expect(h.sendRequest).toHaveBeenLastCalledWith('sidebarInputs.reportView', AWAY)
    // iOS passes through inactive on the way back; only the edge into active is news.
    changeAppState('inactive')
    changeAppState('active')
    expect(h.reports()).toEqual([BACK, AWAY, BACK])
    h.unmount()
    changeAppState('background')
    expect(h.reports()).toHaveLength(3)
  })

  it('waits for a connection, then says the current state', () => {
    lifecycle.appState = 'background'
    const h = harness('connecting')
    expect(h.sendRequest).not.toHaveBeenCalled()
    h.setConnState('connected')
    expect(h.reports()).toEqual([AWAY])
  })

  it('ignores a host that refuses the report', async () => {
    const h = harness()
    h.sendRequest.mockRejectedValueOnce(new Error('method_not_found'))
    changeAppState('background')
    await Promise.resolve()
    expect(h.reports()).toEqual([BACK, AWAY])
  })
})
