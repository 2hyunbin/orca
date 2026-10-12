// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import type * as HostSessionTabSourceProjection from './host-session-tab-source-projection'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

function frame(worktree: string, version: number): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'browser-epoch',
    snapshotVersion: version,
    activeGroupId: 'group',
    activeTabId: null,
    activeTabType: null,
    tabs: ['a', 'b', 'c'].map((id) => ({
      type: 'browser',
      id: `host-${id}`,
      browserPageId: `page-${id}`,
      browserWorkspaceId: `workspace-${id}`,
      url: `https://example.com/${id}`,
      title: `${id}-${version}`,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isActive: false
    })),
    tabGroups: [{ id: 'group', tabOrder: ['host-a', 'host-b', 'host-c'], activeTabId: null }]
  }
}

it.each(['reread', 'frame', 'overlap', 'moved', 'alias-superseded', 'rejected-loader'] as const)(
  'restores the captured occurrence in the first real frame while recovery is cold: %s',
  async (scenario) => {
    vi.resetModules()
    let release = (): void => {}
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const requested = vi.fn()
    const loaded = vi.fn()
    const projected = vi.fn()
    vi.doMock('./host-session-tab-source-projection', async (importOriginal) => {
      requested()
      await ready
      if (scenario === 'rejected-loader') {
        loaded()
        throw new Error('cold order recovery unavailable')
      }
      const actual = await importOriginal<typeof HostSessionTabSourceProjection>()
      loaded()
      return {
        ...actual,
        reprojectHostSessionTabSource: (
          ticket: Parameters<typeof actual.reprojectHostSessionTabSource>[0]
        ) => {
          projected()
          actual.reprojectHostSessionTabSource(ticket)
        }
      }
    })
    const { useAppStore } = await import('../store')
    const { settleHostSessionTabClose } = await import('./host-session-tab-close')
    const intent = await import('./web-session-close-intent')
    const revision = await import('./runtime-environment-revision')
    const { applyWebSessionTabsSnapshot } = await import('./web-session-tabs-sync/snapshot-api')
    const { applyWebSessionTabsStorePatch } = await import('./web-session-tabs-sync/store-patch')
    const { decideWebSessionTabsSnapshot } =
      await import('./web-session-tabs-sync/tracking-decisions')
    const { resetWebSessionTabsSnapshotFreshnessForTests } =
      await import('./web-session-tabs-sync/tracking-lifecycle')
    const initial = useAppStore.getState()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wt = `cold-order-${scenario}`
    const env = `cold-owner-${scenario}`
    const order = (): string[] => useAppStore.getState().groupsByWorktree[wt][0].tabOrder
    const apply = (version: number): void => {
      const snapshot = frame(wt, version)
      const decision = decideWebSessionTabsSnapshot(snapshot, env)
      expect(decision.apply).toBe(true)
      applyWebSessionTabsStorePatch((state) => applyWebSessionTabsSnapshot(state, snapshot, env), {
        frames: [{ environmentId: env, worktreeId: wt, source: snapshot, decision }]
      })()
    }
    const reorder = (ids: string[]): void => {
      useAppStore.setState((state) => ({
        groupsByWorktree: {
          ...state.groupsByWorktree,
          [wt]: state.groupsByWorktree[wt].map((group) => ({
            ...group,
            tabOrder: ids,
            activeTabId: 'host-c'
          }))
        },
        tabBarOrderByWorktree: { ...state.tabBarOrderByWorktree, [wt]: ids }
      }))
    }
    revision.replaceRuntimeEnvironmentRevisions([{ id: env, createdAt: 0, pairingRevision: 3 }])
    try {
      apply(1)
      useAppStore.setState((state) => ({
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          [wt]: state.unifiedTabsByWorktree[wt].map((tab) =>
            tab.id === 'host-b' ? { ...tab, id: 'client-b' } : tab
          )
        },
        groupsByWorktree: {
          ...state.groupsByWorktree,
          [wt]: state.groupsByWorktree[wt].map((group) => ({
            ...group,
            tabOrder: group.tabOrder.map((id) => (id === 'host-b' ? 'client-b' : id))
          }))
        },
        tabBarOrderByWorktree: {
          ...state.tabBarOrderByWorktree,
          [wt]: state.tabBarOrderByWorktree[wt].map((id) => (id === 'host-b' ? 'client-b' : id))
        }
      }))
      apply(2)
      expect(order()).toEqual(['host-a', 'client-b', 'host-c'])
      const alias = intent.beginWebSessionCloseIntent(
        { environmentId: env },
        wt,
        'client-b',
        Date.now()
      )
      const original = intent.beginWebSessionCloseIntent(
        { environmentId: env },
        wt,
        'host-b',
        Date.now()
      )
      if (!alias || !original) {
        throw new Error('missing original close tickets')
      }
      expect(original.placement?.localTabId).toBe('client-b')
      expect(original.placement?.previousTabId).toBe('host-a')
      expect(original.placement?.nextTabId).toBe('host-c')
      apply(3)
      expect(order()).toEqual(['host-a', 'host-c'])
      reorder(['host-a', 'host-c'])
      const firstRestorations: string[][] = []
      const unsubscribe = useAppStore.subscribe((state) => {
        const ids = state.groupsByWorktree[wt]?.[0]?.tabOrder ?? []
        if (ids.includes('host-b')) {
          firstRestorations.push([...ids])
        }
      })
      try {
        const reread = vi.fn(async () => {
          if (scenario === 'reread') {
            apply(4)
          }
        })
        await expect(
          settleHostSessionTabClose({
            tickets: () => [alias, original],
            close: Promise.reject(new Error('offline')),
            reread,
            readAfterClose: false
          })
        ).resolves.toBe('failed')
        await vi.waitFor(() => expect(requested).toHaveBeenCalledOnce())
        expect(projected).not.toHaveBeenCalled()
        expect(loaded).not.toHaveBeenCalled()
        expect(reread).toHaveBeenCalledWith(true)
        expect(
          intent.isWebSessionCloseIntentPending(original.owner, wt, original.closedId, Date.now())
        ).toBe(false)
        if (scenario === 'rejected-loader') {
          release()
          await vi.waitFor(() =>
            expect(warn).toHaveBeenCalledWith(
              '[session-tabs] could not load closed tab recovery',
              expect.anything()
            )
          )
          expect(order()).toEqual(['host-a', 'host-c'])
        }
        if (scenario === 'alias-superseded') {
          const newerAlias = intent.beginWebSessionCloseIntent(
            { environmentId: env },
            wt,
            'client-b',
            Date.now()
          )
          expect(newerAlias?.entry).not.toBe(alias.entry)
          apply(4)
          // The old operation may no longer restore its placement after any alias is replaced.
          expect(order()).toEqual(['host-a', 'host-c', 'host-b'])
        } else {
          if (scenario !== 'reread') {
            apply(4)
          }
          expect(firstRestorations[0]).toEqual(['host-a', 'host-b', 'host-c'])
          expect(order()).toEqual(['host-a', 'host-b', 'host-c'])
          expect(intent.isFailedWebSessionCloseIntents([alias, original], Date.now())).toBe(true)
          expect(useAppStore.getState().tabBarOrderByWorktree[wt]).toEqual(order())
          if (scenario === 'overlap') {
            reorder(['host-c', 'host-b', 'host-a'])
            const newer = intent.beginWebSessionCloseIntent(
              { environmentId: env },
              wt,
              'host-b',
              Date.now()
            )
            if (!newer) {
              throw new Error('missing newer close')
            }
            expect(newer.placement?.previousTabId).toBe('host-c')
            expect(newer.placement?.nextTabId).toBe('host-a')
            apply(5)
            expect(order()).toEqual(['host-c', 'host-a'])
            await expect(
              settleHostSessionTabClose({
                tickets: () => [newer],
                close: Promise.reject(new Error('second offline')),
                reread: async () => {
                  apply(6)
                },
                readAfterClose: false
              })
            ).resolves.toBe('failed')
            expect(order()).toEqual(['host-c', 'host-b', 'host-a'])
          } else if (scenario === 'moved') {
            reorder(['host-c', 'host-a', 'host-b'])
            apply(5)
            expect(order()).toEqual(['host-c', 'host-a', 'host-b'])
          }
        }
        const beforeRelease = [...order()]
        release()
        await vi.waitFor(() => expect(loaded).toHaveBeenCalled())
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        expect(order()).toEqual(beforeRelease)
        expect(useAppStore.getState().groupsByWorktree[wt][0].activeTabId).toBe('host-c')
        expect(useAppStore.getState().tabBarOrderByWorktree[wt]).toEqual(beforeRelease)
        expect(warn).not.toHaveBeenCalledWith(
          '[session-tabs] could not restore closed tab from its host source',
          expect.anything()
        )
      } finally {
        unsubscribe()
      }
    } finally {
      release()
      await vi.waitFor(() => expect(loaded).toHaveBeenCalled())
      intent.resetWebSessionCloseIntentForTests()
      resetWebSessionTabsSnapshotFreshnessForTests()
      revision.replaceRuntimeEnvironmentRevisions([])
      useAppStore.setState(initial, true)
      vi.doUnmock('./host-session-tab-source-projection')
      vi.restoreAllMocks()
    }
  }
)
