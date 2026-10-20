import { createElement, Fragment, useContext, useEffect } from 'react'
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

// A screen's focus comes from `RouteFocus`: the callback runs while it holds, its cleanup on blur.
const { RouteFocus } = await vi.hoisted(async () => {
  const { createContext } = await import('react')
  return { RouteFocus: createContext(true) }
})

vi.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void | (() => void)) => {
    const focused = useContext(RouteFocus)
    useEffect(() => (focused ? callback() : undefined), [callback, focused])
  }
}))

vi.mock('../../../src/shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const A = 'repo-1::/tmp/a'
const B = 'repo-1::/tmp/b'
const AWAY = { workspaceIds: [], tabIds: [], presentForMs: 0 }
const shows = (...workspaceIds: string[]) => ({ workspaceIds, tabIds: [], presentForMs: null })

type Screen = { worktreeId: string; focused: boolean }

function harness(screens: Screen[], connState: ConnectionState = 'connected') {
  const sendRequest = vi.fn(async (_method: string, _params: unknown) => ({ ok: true }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook calls only sendRequest.
  const client = { sendRequest } as unknown as RpcClient
  function Probe(props: { worktreeId: string; state: ConnectionState }) {
    usePhonePresenceReport(client, props.state, props.worktreeId)
    return null
  }
  const tree = (next: Screen[], state: ConnectionState) =>
    createElement(
      Fragment,
      null,
      next.map((screen) =>
        createElement(
          RouteFocus.Provider,
          { key: screen.worktreeId, value: screen.focused },
          createElement(Probe, { worktreeId: screen.worktreeId, state })
        )
      )
    )
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(tree(screens, connState))
  })
  return {
    sendRequest,
    reports: () => sendRequest.mock.calls.map(([, params]) => params),
    last: () => sendRequest.mock.lastCall?.[1],
    update: (next: Screen[], state: ConnectionState = 'connected') =>
      act(() => renderer.update(tree(next, state))),
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
  it('names the focused session route, and is away when another screen covers it', () => {
    const h = harness([{ worktreeId: A, focused: true }])
    expect(h.last()).toEqual(shows(A))
    // Settings pushed on top: the session stays mounted, but nobody sees it.
    h.update([{ worktreeId: A, focused: false }])
    expect(h.last()).toEqual(AWAY)
    h.update([{ worktreeId: A, focused: true }])
    expect(h.last()).toEqual(shows(A))
    h.unmount()
    expect(h.last()).toEqual(AWAY)
  })

  it('reports away in the background, and only the focused route on return', () => {
    const h = harness([{ worktreeId: A, focused: true }])
    changeAppState('background')
    expect(h.last()).toEqual(AWAY)
    // iOS passes through inactive on the way back; only the edge into active is news.
    const sent = h.reports().length
    changeAppState('inactive')
    expect(h.reports()).toHaveLength(sent)
    // Foregrounded with settings still on top: still away.
    h.update([{ worktreeId: A, focused: false }])
    changeAppState('active')
    expect(h.last()).toEqual(AWAY)
    h.update([{ worktreeId: A, focused: true }])
    expect(h.last()).toEqual(shows(A))
  })

  it('names only the route on top when one session route is pushed over another', () => {
    const h = harness([{ worktreeId: A, focused: true }])
    h.update([
      { worktreeId: A, focused: false },
      { worktreeId: B, focused: true }
    ])
    expect(h.last()).toEqual(shows(B))
    h.update([{ worktreeId: A, focused: true }])
    expect(h.last()).toEqual(shows(A))
  })

  it('says the view on connect before a covered route re-subscribes', () => {
    lifecycle.appState = 'active'
    const h = harness([{ worktreeId: A, focused: false }], 'connecting')
    expect(h.sendRequest).not.toHaveBeenCalled()
    h.update([{ worktreeId: A, focused: false }], 'connected')
    expect(h.reports()).toEqual([AWAY])
  })

  it('ignores a host that refuses the report', async () => {
    const h = harness([{ worktreeId: A, focused: true }])
    h.sendRequest.mockRejectedValueOnce(new Error('method_not_found'))
    changeAppState('background')
    await Promise.resolve()
    expect(h.last()).toEqual(AWAY)
  })
})
