import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  HostStackNavigationRoute,
  HostStackNavigationState,
  HostStackRootNavigation
} from '../navigation/host-stack-navigation'
import { getNotificationNavigationTarget } from './notification-routing'
import { useOpenNotificationRoute } from './use-open-notification-route'

const SESSION = '[hostId]/session/[worktreeId]'
const LIST = '[hostId]/index'

type HostStackAction = Parameters<HostStackRootNavigation['dispatch']>[0]

// The root stack's routes as app/_layout.tsx sees them; each `h` route carries its host stack.
type NavigatorModel = {
  root: HostStackNavigationRoute[] | undefined
  listeners: Set<() => void>
  pushes: number
  dispatches: HostStackAction[]
}

const model = vi.hoisted((): NavigatorModel => ({
  root: undefined,
  listeners: new Set(),
  pushes: 0,
  dispatches: []
}))

function stackOf(routes: readonly HostStackNavigationRoute[], key: string) {
  return { key, index: routes.length - 1, routes }
}

function rootState(): HostStackNavigationState | undefined {
  if (!model.root) {
    return undefined
  }
  const inner = stackOf(model.root, 'root')
  return { key: 'internal', index: 0, routes: [{ key: '__root', name: '__root', state: inner }] }
}

function emit(): void {
  for (const listener of model.listeners) {
    listener()
  }
}

// What expo-router's push of `/h/<host>` commits (routing.js findDivergentState): a fresh host
// index on top of a focused host stack, else a new `h` route on the root stack.
function commitPush(hostSegment: string): void {
  const pushed = { key: `pushed-${model.pushes}`, name: LIST, params: { hostId: hostSegment } }
  const root = model.root ?? [{ key: 'index', name: 'index' }]
  const focused = root.at(-1)
  model.root =
    focused?.name === 'h' && focused.state
      ? [
          ...root.slice(0, -1),
          { ...focused, state: stackOf([...focused.state.routes, pushed], focused.state.key!) }
        ]
      : [...root, hostArea(`host-stack-${model.pushes}`, pushed)]
  emit()
}

// Unkeyed routes get keys, as React Navigation rehydrates a partial state.
function rehydrated(routes: readonly HostStackNavigationRoute[]): HostStackNavigationRoute[] {
  return routes.map((route, index) => ({
    key: `reset-${index}`,
    ...route,
    ...(route.state
      ? { state: stackOf(rehydrated(route.state.routes), route.state.key ?? 'rehydrated') }
      : {})
  }))
}

function applyToHostStack(
  routes: readonly HostStackNavigationRoute[],
  action: HostStackAction
): readonly HostStackNavigationRoute[] {
  if (action.type === 'RESET') {
    return rehydrated(action.payload.routes)
  }
  return routes.map((route) => {
    if (route.key !== action.source) {
      return route
    }
    return action.type === 'REPLACE'
      ? { key: 'replaced', ...action.payload }
      : { ...route, params: { ...route.params, ...action.payload.params } }
  })
}

function applyDispatch(action: HostStackAction): void {
  model.dispatches.push(action)
  if (!model.root) {
    return
  }
  if (action.target === 'root' && action.type === 'RESET') {
    model.root = rehydrated(action.payload.routes)
    return
  }
  model.root = model.root.map((route) =>
    route.state?.key === action.target
      ? {
          ...route,
          state: stackOf(applyToHostStack(route.state.routes, action), action.target)
        }
      : route
  )
}

vi.mock('expo-router', () => ({
  useNavigation: () => ({
    addListener: (_event: 'state', listener: () => void) => {
      model.listeners.add(listener)
      return () => model.listeners.delete(listener)
    },
    dispatch: applyDispatch,
    getState: rootState
  }),
  useRouter: () => ({
    push: (route: string) => {
      model.pushes += 1
      queueMicrotask(() => commitPush(route.slice('/h/'.length)))
    },
    replace: vi.fn()
  })
}))

function hostArea(key: string, ...routes: HostStackNavigationRoute[]): HostStackNavigationRoute {
  return { key: `h-${key}`, name: 'h', state: stackOf(routes, key) }
}

function list(hostId: string): HostStackNavigationRoute {
  return { key: `list-${hostId}`, name: LIST, params: { hostId } }
}

function session(hostId: string, worktreeId: string, name = SESSION): HostStackNavigationRoute {
  return { key: `${name}-${worktreeId}`, name, params: { hostId, worktreeId } }
}

const HOME = { key: 'index', name: 'index' }

let renderer: ReactTestRenderer | null = null

async function tapPush(hostId: string, worktreeId: string): Promise<void> {
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
  await act(async () => {
    open(getNotificationNavigationTarget({ hostId, worktreeId })!)
  })
}

function screenName(route: HostStackNavigationRoute): string {
  if (route.name === LIST) {
    return `list:${decodeURIComponent(String(route.params?.hostId))}`
  }
  if (route.state) {
    return `${route.name}[${route.state.routes.map(screenName).join(', ')}]`
  }
  if (route.params?.worktreeId === undefined) {
    return route.name
  }
  const name = route.name === SESSION ? 'session' : route.name
  return `${name}:${String(route.params.worktreeId)}`
}

function rootScreens(): string[] {
  return (model.root ?? []).map(screenName)
}

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  model.root = undefined
  model.listeners.clear()
  model.pushes = 0
  model.dispatches = []
})

describe('a push tap for workspace Y lands on [workspace list, Y]', () => {
  it('from the workspace list', async () => {
    model.root = [HOME, hostArea('hs', list('host'))]
    await tapPush('host', 'Y')
    expect(rootScreens()).toEqual(['index', 'h[list:host, session:Y]'])
  })

  it('from workspace X, whose screen does not stay beneath Y', async () => {
    model.root = [HOME, hostArea('hs', list('host'), session('host', 'X'))]
    await tapPush('host', 'Y')
    expect(rootScreens()).toEqual(['index', 'h[list:host, session:Y]'])
  })

  it('keeps the pushed workspace list mounted rather than remounting it', async () => {
    model.root = [HOME, hostArea('hs', list('host'), session('host', 'X'))]
    await tapPush('host', 'Y')
    expect(model.root?.[1]?.state?.routes[0]?.key).toBe('pushed-1')
  })

  it('from X with Y deeper in the stack, leaving one session screen for Y', async () => {
    model.root = [HOME, hostArea('hs', list('host'), session('host', 'Y'), session('host', 'X'))]
    await tapPush('host', 'Y')
    expect(rootScreens()).toEqual(['index', 'h[list:host, session:Y]'])
  })

  it("from a sub-route on top of Y's session", async () => {
    const sourceControl = session('host', 'Y', '[hostId]/source-control/[worktreeId]')
    model.root = [HOME, hostArea('hs', list('host'), session('host', 'Y'), sourceControl)]
    await tapPush('host', 'Y')
    expect(rootScreens()).toEqual(['index', 'h[list:host, session:Y]'])
  })

  it("from another host's workspace", async () => {
    model.root = [HOME, hostArea('hs', list('other'), session('other', 'X'))]
    await tapPush('host', 'Y')
    expect(rootScreens()).toEqual(['index', 'h[list:host, session:Y]'])
  })

  it("from a root screen above X's host area, leaving one host area", async () => {
    model.root = [
      HOME,
      hostArea('hs', list('host'), session('host', 'X')),
      { key: 'terminal-settings', name: 'terminal-settings' }
    ]
    await tapPush('host', 'Y')
    expect(rootScreens()).toEqual(['index', 'h[list:host, session:Y]'])
    expect(model.root?.[0]?.key).toBe('index')
  })

  it('on cold start, before the root navigator has committed', async () => {
    await tapPush('host', 'Y')
    expect(rootScreens()).toEqual(['index', 'h[list:host, session:Y]'])
  })
})

describe('a push tap for the workspace already on screen (#20310)', () => {
  it('updates its params in place, with no push', async () => {
    model.root = [HOME, hostArea('hs', list('host'), session('host', 'X'), session('host', 'Y'))]
    await tapPush('host', 'Y')
    expect(model.pushes).toBe(0)
    expect(model.dispatches).toEqual([
      expect.objectContaining({ type: 'SET_PARAMS', target: 'hs', source: `${SESSION}-Y` })
    ])
    expect(rootScreens()).toEqual(['index', 'h[list:host, session:X, session:Y]'])
  })
})
