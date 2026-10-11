export type HostStackNavigationState = Readonly<{
  key?: string
  index: number
  routes: readonly HostStackNavigationRoute[]
}>

export type HostStackNavigationRoute = Readonly<{
  key?: string
  name: string
  params?: Readonly<{ hostId?: unknown; worktreeId?: unknown }>
  state?: HostStackNavigationState
}>

/** A screen inside app/h/_layout.tsx plus the params it needs, e.g.
 *  `{ name: '[hostId]/session/[worktreeId]', params: { hostId, worktreeId } }`. */
export type HostStackRouteTarget = Readonly<{
  name: string
  params: Readonly<Record<string, string>>
}>

export type HostStackReplaceAction = Readonly<{
  type: 'REPLACE'
  target: string
  source: string
  payload: HostStackRouteTarget
}>

/** What the target lands on: nothing beneath it in a fresh host stack (Home's entries, whose
 *  Back returns Home), or only its host's workspace list (a notification tap). */
export type HostStackLanding = 'replace-host-index' | 'over-workspace-list'

export type HostStackResetAction = Readonly<{
  type: 'RESET'
  target: string
  payload: Readonly<{ index: number; routes: readonly HostStackNavigationRoute[] }>
}>

export type HostStackRootNavigation = {
  addListener: (event: 'state', listener: () => void) => () => void
  dispatch: (
    action:
      | HostStackReplaceAction
      | HostStackResetAction
      | Readonly<{
          type: 'SET_PARAMS'
          target: string
          source: string
          payload: { params: Readonly<Record<string, string>> }
        }>
  ) => void
  // Why: the root layout's navigator has no committed state until it hydrates, and a
  // notification tap can arm the transition before that first commit.
  getState: () => HostStackNavigationState | undefined
}

export type HostStackHostRoute = `/h/${string}`

export type HostStackRouteHref = Readonly<{
  pathname: `/h/${string}`
  params: Readonly<Record<string, string>>
}>

export type HostStackRouter = {
  push: (route: HostStackHostRoute) => void
  replace: (route: HostStackRouteHref) => void
}

export type HostStackNavigationController = Readonly<{
  cancel: () => void
  isActive: () => boolean
  retarget: (target: HostStackRouteTarget, landing: HostStackLanding) => void
}>

export type PendingHostStackNavigation = Readonly<{
  hostId: string
  controller: HostStackNavigationController
}>

export function hostStackHostRoute(hostId: string): HostStackHostRoute {
  return `/h/${encodeURIComponent(hostId)}`
}

export function hostStackRouteHref(target: HostStackRouteTarget): HostStackRouteHref {
  return { pathname: `/h/${target.name}`, params: target.params }
}

// Why: the host is pushed as an encoded segment, so the committed route may hold
// either form — an id with `/`, `#`, or `%` must still match its own push.
function hostParamMatches(param: unknown, expectedHostId: string): boolean {
  if (typeof param !== 'string') {
    return false
  }
  if (param === expectedHostId) {
    return true
  }
  try {
    return decodeURIComponent(param) === expectedHostId
  } catch {
    return false // Lone `%` — not our encoding.
  }
}

/** The focused `h` route and the root stack holding it, however deep the caller's navigator
 *  sits above it: a screen inside the root stack sees it at the top, but app/_layout.tsx is
 *  itself a screen of Expo Router's internal navigator, so from there it is one level down. */
function focusedHostRoute(
  state: HostStackNavigationState
): { route: HostStackNavigationRoute; rootStack: HostStackNavigationState } | null {
  let current: HostStackNavigationState | undefined = state
  while (current) {
    const route: HostStackNavigationRoute | undefined = current.routes[current.index]
    if (!route) {
      return null
    }
    if (route.name === 'h') {
      return { route, rootStack: current }
    }
    current = route.state
  }
  return null
}

function mountedHostStack(
  hostContainer: HostStackNavigationRoute,
  expectedHostId: string
): { key: string; hostRoute: HostStackNavigationRoute & { key: string } } | null {
  const hostState = hostContainer.state
  const hostRoute = hostState?.routes[hostState.index]
  if (
    !hostState?.key ||
    hostRoute?.name !== '[hostId]/index' ||
    !hostRoute.key ||
    !hostParamMatches(hostRoute.params?.hostId, expectedHostId)
  ) {
    return null
  }
  return { key: hostState.key, hostRoute: { ...hostRoute, key: hostRoute.key } }
}

/** Leaves the root stack's routes below its first host area, then this host area holding only
 *  its pushed workspace list and the target. The push stacked onto wherever focus was — this host
 *  stack, or a root screen above an earlier `h` — and a session screen left beneath stays mounted,
 *  subscribed to its terminals under this device's id. */
function landOverWorkspaceList(
  hostArea: { route: HostStackNavigationRoute; rootStack: HostStackNavigationState },
  hostStack: NonNullable<ReturnType<typeof mountedHostStack>>,
  target: HostStackRouteTarget
): HostStackResetAction {
  const routes = [hostStack.hostRoute, target]
  const { rootStack } = hostArea
  if (!rootStack.key) {
    return { type: 'RESET', target: hostStack.key, payload: { index: 1, routes } }
  }
  const firstHostArea = rootStack.routes.findIndex((route) => route.name === 'h')
  return {
    type: 'RESET',
    target: rootStack.key,
    payload: {
      index: firstHostArea,
      routes: [
        ...rootStack.routes.slice(0, firstHostArea),
        { ...hostArea.route, state: { key: hostStack.key, index: 1, routes } }
      ]
    }
  }
}

/** Opens a deep host route by mounting `/h/[hostId]` first and replacing it once
 *  its stack is committed. A cold push straight to a nested route resolves to the
 *  host index without the dynamic id, which lands on a blank host screen. */
export function navigateToHostStackRoute(
  navigation: HostStackRootNavigation,
  router: HostStackRouter,
  hostId: string,
  target: HostStackRouteTarget,
  landing: HostStackLanding = 'replace-host-index'
): HostStackNavigationController {
  const state = navigation.getState()
  const hostState = state && focusedHostRoute(state)?.route.state
  const focused = hostState?.routes[hostState.index]
  if (
    hostState?.key &&
    focused?.key &&
    focused.name === target.name &&
    hostParamMatches(focused.params?.hostId, hostId) &&
    hostParamMatches(focused.params?.worktreeId, target.params.worktreeId)
  ) {
    navigation.dispatch({
      type: 'SET_PARAMS',
      target: hostState.key,
      source: focused.key,
      payload: { params: target.params }
    })
    return { cancel: () => {}, isActive: () => false, retarget: () => {} }
  }

  let active = true
  let hostRouteSeen = false
  let selectedTarget = target
  let selectedLanding = landing
  let unsubscribeState = () => {}
  const dispose = () => {
    if (!active) {
      return
    }
    active = false
    unsubscribeState()
  }

  // Why: cold Expo deep links resolve to index; target the route only after its HostStack exists.
  const onState = () => {
    if (!active) {
      return
    }
    const state = navigation.getState()
    if (!state) {
      return
    }
    const hostArea = focusedHostRoute(state)
    const hostContainer = hostArea?.route
    if (hostContainer) {
      hostRouteSeen = true
    } else if (hostRouteSeen) {
      dispose()
      return
    }
    const hostStack = hostArea && mountedHostStack(hostArea.route, hostId)
    if (!hostStack) {
      if (hostContainer && hostParamMatches(hostContainer.params?.hostId, hostId)) {
        dispose()
        router.replace(hostStackRouteHref(selectedTarget))
      }
      return
    }
    dispose()
    navigation.dispatch(
      selectedLanding === 'over-workspace-list'
        ? landOverWorkspaceList(hostArea, hostStack, selectedTarget)
        : {
            type: 'REPLACE',
            target: hostStack.key,
            source: hostStack.hostRoute.key,
            payload: selectedTarget
          }
    )
  }

  try {
    unsubscribeState = navigation.addListener('state', onState)
    router.push(hostStackHostRoute(hostId))
  } catch (error) {
    dispose()
    throw error
  }
  return {
    cancel: dispose,
    isActive: () => active,
    retarget: (nextTarget, nextLanding) => {
      if (active) {
        selectedTarget = nextTarget
        selectedLanding = nextLanding
      }
    }
  }
}

export function coordinateHostStackNavigation(
  current: PendingHostStackNavigation | null,
  navigation: HostStackRootNavigation,
  router: HostStackRouter,
  hostId: string,
  target: HostStackRouteTarget,
  landing: HostStackLanding = 'replace-host-index'
): PendingHostStackNavigation {
  if (current?.hostId === hostId && current.controller.isActive()) {
    current.controller.retarget(target, landing)
    return current
  }
  current?.controller.cancel()
  return {
    hostId,
    controller: navigateToHostStackRoute(navigation, router, hostId, target, landing)
  }
}
