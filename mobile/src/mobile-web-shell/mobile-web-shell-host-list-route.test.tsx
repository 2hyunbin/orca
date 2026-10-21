import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RouteDependencies = {
  pathnames: string[]
  routes: { pathname: string; params?: Record<string, string> }[]
  clears: ((param: string, value: string) => void)[]
  setParams: Record<string, string>[]
  hostId: string | string[]
  action: string | undefined
  refusals: number
}

const dependencies = vi.hoisted((): RouteDependencies => ({
  pathnames: [],
  routes: [],
  clears: [],
  setParams: [],
  hostId: 'host-1',
  action: undefined,
  refusals: 0
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View'
}))

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ hostId: dependencies.hostId, action: dependencies.action }),
  useRouter: () => ({
    setParams: (params: Record<string, string>) => dependencies.setParams.push(params)
  })
}))

vi.mock('./PageRouteUnavailableScreen', () => ({
  PageRouteUnavailableScreen: () => {
    dependencies.refusals += 1
    return null
  }
}))

vi.mock('./MobileWebShellScreen', () => ({
  MobileWebShellScreen: (props: {
    hostId: string
    route: { pathname: string; params?: Record<string, string> }
    onRouteParamClear?: (param: string, value: string) => void
  }) => {
    dependencies.pathnames.push(props.route.pathname)
    dependencies.routes.push(props.route)
    if (props.onRouteParamClear) {
      dependencies.clears.push(props.onRouteParamClear)
    }
    return null
  }
}))

import { BRIDGE_ROUTE_PATHNAME_PATTERN } from './bridge/bridge-caps'
import HostWorktreeRoute from '../../app/h/[hostId]/index'

async function renderRoute(): Promise<void> {
  await act(async () => {
    create(createElement(HostWorktreeRoute))
  })
}

describe('the worktree-list route that hands off to the shell', () => {
  beforeEach(() => {
    dependencies.pathnames.length = 0
    dependencies.routes.length = 0
    dependencies.clears.length = 0
    dependencies.setParams.length = 0
    dependencies.refusals = 0
    dependencies.hostId = 'host-1'
    dependencies.action = undefined
  })

  it("hands the page the home screen's New Workspace request, which the list opens the sheet for", async () => {
    dependencies.action = 'newWorktree'
    await renderRoute()
    expect(dependencies.routes).toEqual([
      { pathname: '/h/host-1', params: { action: 'newWorktree' } }
    ])
  })

  it('sends no params when nothing was asked for', async () => {
    await renderRoute()
    expect(dependencies.routes).toEqual([{ pathname: '/h/host-1' }])
  })

  it('erases the request once the page names it back, and only that one', async () => {
    dependencies.action = 'newWorktree'
    await renderRoute()
    const clear = dependencies.clears.at(-1)
    clear?.('paneKey', 'newWorktree')
    clear?.('action', 'other')
    expect(dependencies.setParams).toEqual([])
    clear?.('action', 'newWorktree')
    expect(dependencies.setParams).toEqual([{ action: '' }])
  })

  it('encodes the host id into the pathname, like the shell route already does', async () => {
    for (const hostId of ['a?b', 'a#b', 'a b', 'a/b', 'a\\b']) {
      dependencies.hostId = hostId
      dependencies.pathnames.length = 0
      await renderRoute()
      const pathname = dependencies.pathnames[0]
      expect(pathname, hostId).toBe(`/h/${encodeURIComponent(hostId)}`)
      expect(BRIDGE_ROUTE_PATHNAME_PATTERN.test(pathname ?? ''), hostId).toBe(true)
      expect(decodeURIComponent((pathname ?? '').slice('/h/'.length)), hostId).toBe(hostId)
    }
  })

  it('refuses a dot-segment host id instead of handing over a route the page refuses', async () => {
    // `encodeURIComponent` leaves a dot alone and `%2e%2e` is a dot segment to the URL parser too,
    // so this one cannot be encoded into a pathname the bridge accepts.
    for (const hostId of ['..', '.']) {
      dependencies.hostId = hostId
      dependencies.pathnames.length = 0
      dependencies.refusals = 0
      await renderRoute()
      expect(BRIDGE_ROUTE_PATHNAME_PATTERN.test(`/h/${hostId}`), hostId).toBe(false)
      expect(dependencies.pathnames, hostId).toEqual([])
      expect(dependencies.refusals, hostId).toBeGreaterThan(0)
    }
  })

  it('opens the first of a repeated host id, never the pair joined into one', async () => {
    // Expo Router answers a repeated key with an array. Interpolated, `String(['a','b'])` is
    // `a,b` and `encodeURIComponent` makes that the single segment `a%2Cb`, which the bridge's
    // segment rule accepts — so the shell would open a page for a host nobody has.
    dependencies.hostId = ['host-1', 'host-2']
    await renderRoute()
    expect(dependencies.pathnames).toEqual(['/h/host-1'])
  })

  it('refuses an empty repeated host id, which names no host at all', async () => {
    dependencies.hostId = []
    await renderRoute()
    expect(dependencies.pathnames).toEqual([])
    expect(dependencies.refusals).toBeGreaterThan(0)
  })
})
