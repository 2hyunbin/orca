import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  workspaceLanding,
  type HostStackNavigationRoute,
  type HostStackNavigationState
} from '../navigation/host-stack-navigation'
import { mobileSessionRouteTarget } from '../session/mobile-session-route'
import { getNotificationNavigationTarget } from './notification-routing'
import { useOpenNotificationRoute } from './use-open-notification-route'

const ROOT_SCREENS = ['index', 'terminal-settings', 'h']
const Y = mobileSessionRouteTarget({ hostId: 'host', worktreeId: 'Y' })

function list(hostId: string): HostStackNavigationRoute {
  return { key: `list-${hostId}`, name: '[hostId]/index', params: { hostId } }
}

function session(worktreeId: string, name = '[hostId]/session/[worktreeId]') {
  return { key: `${name}-${worktreeId}`, name, params: { hostId: 'host', worktreeId } }
}

// A pushed `h` carries the nested-screen params expo-router builds (getPayloadFromStateRoute).
function hostArea(...routes: HostStackNavigationRoute[]): HostStackNavigationRoute {
  const params = { hostId: 'host', screen: '[hostId]/index', params: { hostId: 'host' } }
  return { key: 'h-1', name: 'h', params, state: { key: 'hs', index: routes.length - 1, routes } }
}

function rootStack(...routes: HostStackNavigationRoute[]) {
  return { key: 'root', index: routes.length - 1, routeNames: ROOT_SCREENS, routes }
}

const HOME = { key: 'index', name: 'index' }
const SETTINGS = { key: 'terminal-settings', name: 'terminal-settings' }

describe('workspaceLanding leaves [workspace list, Y] in one host area', () => {
  it.each([
    ['the workspace list', [HOME], [list('host')], 'reused'],
    ['workspace X', [HOME], [list('host'), session('X')], 'reused'],
    ['X with Y deeper', [HOME], [list('host'), session('Y'), session('X')], 'reused'],
    [
      'a sub-route of Y',
      [HOME],
      [list('host'), session('Y'), session('Y', '[hostId]/source-control/[worktreeId]')],
      'reused'
    ],
    ["another host's workspace", [HOME], [list('other'), session('X')], 'fresh']
  ] as const)('from %s', (_from, below, hostRoutes, listing) => {
    const area = hostArea(...hostRoutes)
    const landing = workspaceLanding(rootStack(...below, area), 'host', Y)

    expect(landing).toEqual({
      type: 'RESET',
      target: 'root',
      payload: {
        index: below.length,
        routes: [
          ...below,
          {
            ...area,
            state: {
              index: 1,
              routes: [{ name: '[hostId]/index', params: { hostId: 'host' } }, Y].map((route, i) =>
                i === 0 && listing === 'reused' ? hostRoutes[0] : route
              )
            }
          }
        ]
      }
    })
    const landedArea = landing.payload.routes[below.length]
    expect(landedArea?.key).toBe(area.key)
    expect(landedArea?.params).toBe(area.params)
    if (listing === 'reused') {
      expect(landedArea?.state?.routes[0]).toBe(hostRoutes[0])
    }
  })

  it('from a root screen above X, dropping it with the host area beneath', () => {
    const area = hostArea(list('host'), session('X'))
    const landing = workspaceLanding(rootStack(HOME, area, SETTINGS), 'host', Y)

    expect(landing.payload.index).toBe(1)
    expect(landing.payload.routes[0]).toBe(HOME)
    expect(landing.payload.routes[1]?.params).toBe(area.params)
    expect(landing.payload.routes[1]?.state?.routes).toEqual([area.state!.routes[0], Y])
    expect(landing.payload.routes).toHaveLength(2)
  })

  it('on cold start, with no host area yet', () => {
    expect(workspaceLanding(rootStack(HOME), 'host', Y)).toEqual({
      type: 'RESET',
      target: 'root',
      payload: {
        index: 1,
        routes: [
          HOME,
          {
            name: 'h',
            state: { index: 1, routes: [{ name: '[hostId]/index', params: { hostId: 'host' } }, Y] }
          }
        ]
      }
    })
  })
})

const navigator = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const state: { current: HostStackNavigationState | undefined } = { current: undefined }
  return {
    listeners,
    state,
    dispatch: vi.fn(),
    push: vi.fn(),
    commit(next: HostStackNavigationState) {
      state.current = next
      for (const listener of listeners) {
        listener()
      }
    }
  }
})

vi.mock('expo-router', () => ({
  useNavigation: () => ({
    addListener: (_event: 'state', listener: () => void) => {
      navigator.listeners.add(listener)
      return () => navigator.listeners.delete(listener)
    },
    dispatch: navigator.dispatch,
    getState: () => navigator.state.current
  }),
  useRouter: () => ({ push: navigator.push, replace: vi.fn() })
}))

// app/_layout.tsx is a screen of Expo Router's internal navigator, one level above the root stack.
function asSeenByRootLayout(root: HostStackNavigationState): HostStackNavigationState {
  return { key: 'internal', index: 0, routes: [{ key: '__root', name: '__root', state: root }] }
}

let renderer: ReactTestRenderer | null = null

async function tapPush(worktreeId: string): Promise<void> {
  const hook: { open?: ReturnType<typeof useOpenNotificationRoute> } = {}
  function Probe() {
    hook.open = useOpenNotificationRoute()
    return null
  }
  await act(async () => {
    renderer = create(createElement(Probe))
  })
  const open = hook.open
  if (!open) {
    throw new Error('the notification hook did not render')
  }
  open(getNotificationNavigationTarget({ hostId: 'host', worktreeId })!)
}

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  navigator.state.current = undefined
  navigator.listeners.clear()
  navigator.dispatch.mockReset()
  navigator.push.mockReset()
})

describe('a push tap through the notification hook', () => {
  it('on cold start, lands only once the root stack has committed', async () => {
    await tapPush('Y')
    expect(navigator.dispatch).not.toHaveBeenCalled()

    navigator.commit({ key: 'internal', index: 0, routes: [{ key: '__root', name: '__root' }] })
    expect(navigator.dispatch).not.toHaveBeenCalled()

    navigator.commit(asSeenByRootLayout(rootStack(HOME)))
    navigator.commit(asSeenByRootLayout(rootStack(HOME)))
    expect(navigator.dispatch).toHaveBeenCalledExactlyOnceWith(
      workspaceLanding(rootStack(HOME), 'host', Y)
    )
    expect(navigator.push).not.toHaveBeenCalled()
  })

  it('updates the workspace already on screen in place (#20310)', async () => {
    navigator.state.current = asSeenByRootLayout(
      rootStack(HOME, hostArea(list('host'), session('X'), session('Y')))
    )
    await tapPush('Y')

    expect(navigator.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: 'SET_PARAMS',
      target: 'hs',
      source: session('Y').key,
      payload: { params: Y.params }
    })
    expect(navigator.push).not.toHaveBeenCalled()
  })
})
