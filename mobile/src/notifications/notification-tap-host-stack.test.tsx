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

// The root stack as app/_layout.tsx sees it, with the host stack's routes laid out flat.
type NavigatorModel = {
  root: { routes: string[]; host: HostStackNavigationRoute[] | null } | undefined
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

function hostState(): HostStackNavigationState | undefined {
  const root = model.root
  if (!root) {
    return undefined
  }
  const routes: HostStackNavigationRoute[] = root.routes.map((name) => ({ key: name, name }))
  if (root.host) {
    routes.push({
      key: 'h',
      name: 'h',
      state: { key: 'host-stack', index: root.host.length - 1, routes: root.host }
    })
  }
  const inner = { key: 'root', index: routes.length - 1, routes }
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
  const root = model.root ?? { routes: ['index'], host: null }
  model.root = { ...root, host: [...(root.host ?? []), pushed] }
  emit()
}

// React Navigation's handling of the three actions the transition dispatches.
function applyDispatch(action: HostStackAction): void {
  model.dispatches.push(action)
  const root = model.root
  if (!root?.host || action.target !== 'host-stack') {
    return
  }
  if (action.type === 'RESET') {
    root.host = action.payload.routes.map((route, index) => ({
      key: `reset-${index}`,
      ...route
    }))
    return
  }
  root.host = root.host.map((route) => {
    if (route.key !== action.source) {
      return route
    }
    return action.type === 'REPLACE'
      ? { key: 'replaced', ...action.payload }
      : { ...route, params: { ...route.params, ...action.payload.params } }
  })
}

vi.mock('expo-router', () => ({
  useNavigation: () => ({
    addListener: (_event: 'state', listener: () => void) => {
      model.listeners.add(listener)
      return () => model.listeners.delete(listener)
    },
    dispatch: applyDispatch,
    getState: hostState
  }),
  useRouter: () => ({
    push: (route: string) => {
      model.pushes += 1
      queueMicrotask(() => commitPush(route.slice('/h/'.length)))
    },
    replace: vi.fn()
  })
}))

function list(hostId: string): HostStackNavigationRoute {
  return { key: `list-${hostId}`, name: LIST, params: { hostId } }
}

function session(hostId: string, worktreeId: string, name = SESSION): HostStackNavigationRoute {
  return { key: `${name}-${worktreeId}`, name, params: { hostId, worktreeId } }
}

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

function screensUnderHost(): string[] {
  return (model.root?.host ?? []).map((route) =>
    route.name === LIST
      ? `list:${decodeURIComponent(String(route.params?.hostId))}`
      : `${route.name === SESSION ? 'session' : route.name}:${String(route.params?.worktreeId)}`
  )
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
    model.root = { routes: ['index'], host: [list('host')] }
    await tapPush('host', 'Y')
    expect(screensUnderHost()).toEqual(['list:host', 'session:Y'])
  })

  it('from workspace X, whose screen does not stay beneath Y', async () => {
    model.root = { routes: ['index'], host: [list('host'), session('host', 'X')] }
    await tapPush('host', 'Y')
    expect(screensUnderHost()).toEqual(['list:host', 'session:Y'])
  })

  it('from X with Y deeper in the stack, leaving one session screen for Y', async () => {
    model.root = {
      routes: ['index'],
      host: [list('host'), session('host', 'Y'), session('host', 'X')]
    }
    await tapPush('host', 'Y')
    expect(screensUnderHost()).toEqual(['list:host', 'session:Y'])
  })

  it("from a sub-route on top of Y's session", async () => {
    model.root = {
      routes: ['index'],
      host: [
        list('host'),
        session('host', 'Y'),
        session('host', 'Y', '[hostId]/source-control/[worktreeId]')
      ]
    }
    await tapPush('host', 'Y')
    expect(screensUnderHost()).toEqual(['list:host', 'session:Y'])
  })

  it("from another host's workspace", async () => {
    model.root = { routes: ['index'], host: [list('other'), session('other', 'X')] }
    await tapPush('host', 'Y')
    expect(screensUnderHost()).toEqual(['list:host', 'session:Y'])
  })

  it('on cold start, before the root navigator has committed', async () => {
    await tapPush('host', 'Y')
    expect(model.root?.routes).toEqual(['index'])
    expect(screensUnderHost()).toEqual(['list:host', 'session:Y'])
  })

  it('updates an already focused Y in place, with no push (#20310)', async () => {
    model.root = {
      routes: ['index'],
      host: [list('host'), session('host', 'X'), session('host', 'Y')]
    }
    await tapPush('host', 'Y')
    expect(model.pushes).toBe(0)
    expect(model.dispatches).toEqual([
      expect.objectContaining({ type: 'SET_PARAMS', source: `${SESSION}-Y` })
    ])
    expect(screensUnderHost()).toEqual(['list:host', 'session:X', 'session:Y'])
  })
})
