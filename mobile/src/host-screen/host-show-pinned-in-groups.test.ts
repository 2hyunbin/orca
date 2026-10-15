import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

// The desktop's server-list feed loads react-native; its timer never runs without a subscriber.
vi.mock('react-native', () => ({}))
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }))
vi.mock('../cache/worktree-cache', () => ({
  getCachedWorktrees: () => null,
  setCachedWorktrees: () => {}
}))
vi.mock('../storage/preferences', () => ({
  loadPinnedIds: async () => new Set(),
  savePinnedIds: async () => {}
}))
vi.mock('../transport/host-store', () => ({
  loadHosts: async () => [],
  updateLastConnected: async () => {}
}))
vi.mock('../worktree/host-worktree-refresh', () => ({ startHostWorktreeRefresh: () => () => {} }))
vi.mock('../transport/use-worktree-resync', () => ({
  useWorktreeResync: () => ({ refreshing: false, onRefresh: async () => {} })
}))

import type { RpcClient } from '../transport/rpc-client'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'
import { useHostScreenIdentity } from './use-host-screen-identity'
import { useHostViewSettings } from './use-host-view-settings'
import { INITIAL_MOBILE_VIEW, type MobileViewState } from '../worktree/workspace-view-settings'

function reply(result: unknown): RpcResponse {
  return { id: 'reply', ok: true, result, _meta: { runtimeId: 'runtime' } }
}

const noop = () => {}

type ClientRef = { current: RpcClient | null }

function screenState(clientRef: ClientRef, applied: boolean[]) {
  const viewRef = { current: INITIAL_MOBILE_VIEW }
  return {
    clientRef,
    viewRef,
    repoMetadataFetchedAtRef: { current: 0 },
    setView: (view: MobileViewState) => {
      viewRef.current = view
    },
    setShowPinnedInGroups: (show: boolean) => applied.push(show),
    ...Object.fromEntries(
      [
        'setCatalogError',
        'setDesktopRepos',
        'setError',
        'setHostLabelById',
        'setHostHealthById',
        'setHostName',
        'setHostPlatform',
        'setHostStoredDescriptor',
        'setLastKnownWorktrees',
        'setPinnedIds',
        'setRepoHostIdByRepoId',
        'setServedProjectSections',
        'setWorktrees',
        'setWorktreesLoaded'
      ].map((setter) => [setter, noop])
    )
  }
}

// One view sync: ui.get and settings.get go out together, each answered by `answer`.
async function syncWith(
  settings: unknown,
  onSent: (clientRef: ClientRef) => void = noop
): Promise<{ applied: boolean[]; view: MobileViewState; methods: string[] }> {
  const client = new FakeSession('connected')
  const clientRef: ClientRef = { current: client }
  client.sendRequest.mockImplementation(async (method: string) => {
    onSent(clientRef)
    return method === 'settings.get' ? reply({ settings }) : reply({ ui: { groupBy: 'none' } })
  })
  const applied: boolean[] = []
  const state = screenState(clientRef, applied)
  let sync: () => Promise<void> = async () => {}
  function Probe(): null {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the view sync reads only the refs and setters screenState provides.
    const hostState = state as unknown as Parameters<typeof useHostViewSettings>[0]['state']
    sync = useHostViewSettings({
      client,
      connState: 'connected',
      hostId: 'host-1',
      state: hostState
    }).syncViewSettingsFromDesktop
    return null
  }
  await act(async () => {
    create(createElement(Probe))
  })
  await act(async () => {
    await sync()
  })
  return {
    applied,
    view: state.viewRef.current,
    methods: client.sendRequest.mock.calls.map(([method]) => String(method)).sort()
  }
}

describe('the host list mirrors the desktop list settings', () => {
  it('reads them with one settings.get beside ui.get, absent reading as off', async () => {
    const on = await syncWith({
      showPinnedWorktreesInGroups: true,
      compactWorktreeCards: true,
      experimentalNewWorktreeCardStyle: true
    })
    expect(on.methods).toEqual(['settings.get', 'ui.get'])
    expect(on.applied).toEqual([true])
    expect(on.view).toMatchObject({
      groupBy: 'none',
      compactWorktreeCards: true,
      newCardStyle: true
    })
    const off = await syncWith({})
    expect(off.applied).toEqual([false])
    expect(off.view).toMatchObject({ compactWorktreeCards: false, newCardStyle: false })
  })

  it('drops a reply that lands after the screen moved to another client', async () => {
    const moveOn = (clientRef: ClientRef) => {
      clientRef.current = new FakeSession('connected')
    }
    const moved = await syncWith(
      { showPinnedWorktreesInGroups: true, compactWorktreeCards: true },
      moveOn
    )
    expect(moved.applied).toEqual([])
    expect(moved.view).toBe(INITIAL_MOBILE_VIEW)
  })

  it('resets to off when the screen is reused for another host', async () => {
    const applied: boolean[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the identity hook reads only the refs and setters screenState provides.
    const identityState = screenState({ current: null }, applied) as unknown as Parameters<
      typeof useHostScreenIdentity
    >[0]['state']
    function Probe({ hostId }: { hostId: string }): null {
      useHostScreenIdentity({ client: null, hostId, state: identityState })
      return null
    }
    const renderer = create(createElement(Probe, { hostId: 'host-1' }))
    await act(async () => {})
    applied.length = 0
    await act(async () => {
      renderer.update(createElement(Probe, { hostId: 'host-2' }))
    })
    expect(applied).toEqual([false])
  })
})
