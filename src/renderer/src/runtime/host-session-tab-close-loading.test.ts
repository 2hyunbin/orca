import type * as HostSessionTabSourceProjection from './host-session-tab-source-projection'
// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { WebSessionCloseIntentTicket } from './web-session-close-intent'

function frame(wt: string, version: number): RuntimeMobileSessionTabsResult {
  return {
    worktree: wt,
    publicationEpoch: 'epoch',
    snapshotVersion: version,
    activeGroupId: 'group',
    activeTabId: null,
    activeTabType: null,
    tabs: ['a', 'b', 'c'].map((id) => ({
      type: 'agent-session',
      id: `agent-session:${wt}-${id}`,
      sessionId: `${wt}-${id}`,
      title: `${id}-${version}`,
      agent: 'codex',
      isActive: false
    })),
    tabGroups: [
      {
        id: 'group',
        tabOrder: ['a', 'b', 'c'].map((id) => `agent-session:${wt}-${id}`),
        activeTabId: null
      }
    ]
  }
}

it.each([
  'reclose',
  'repair',
  'healthy',
  'throw',
  'overlap',
  'anchors',
  'aliases',
  'alias-overlap',
  'publisher',
  'removed',
  'reread-throw',
  'reject'
] as const)('fences the original ticket across lazy recovery loading: %s', async (scenario) => {
  vi.resetModules()
  let release: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  const requested = vi.fn()
  const loaded = vi.fn()
  const project = vi.fn<(ticket: WebSessionCloseIntentTicket) => void>()
  vi.doMock('./host-session-tab-source-projection', async (importOriginal) => {
    requested()
    await ready
    if (scenario === 'reject') {
      throw new Error('cold recovery module unavailable')
    }
    const actual = await importOriginal<typeof HostSessionTabSourceProjection>()
    project.mockImplementation((ticket) => {
      if (scenario === 'throw') {
        throw new Error('restore bookkeeping failed')
      }
      actual.reprojectHostSessionTabSource(ticket)
    })
    loaded()
    return { ...actual, reprojectHostSessionTabSource: project }
  })
  const { useAppStore } = await import('../store')
  const { settleHostSessionTabClose } = await import('./host-session-tab-close')
  const intent = await import('./web-session-close-intent')
  const take = vi.spyOn(intent, 'isFailedWebSessionCloseIntents')
  const revision = await import('./runtime-environment-revision')
  const { applyWebSessionTabsSnapshot } = await import('./web-session-tabs-sync/snapshot-api')
  const { applyWebSessionTabsStorePatch } = await import('./web-session-tabs-sync/store-patch')
  const { decideWebSessionTabsSnapshot } =
    await import('./web-session-tabs-sync/tracking-decisions')
  const { resetWebSessionTabsSnapshotFreshnessForTests, clearWebSessionTabsTrackingForWorktree } =
    await import('./web-session-tabs-sync/tracking-lifecycle')
  const { recordReceivedWebSessionTabsSnapshot } = await import('./web-session-tabs-sync/tracking')
  const initial = useAppStore.getState()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const wt = `loading-${scenario}`
  const env = `env-${scenario}`
  const closedId = `agent-session:${wt}-b`
  const apply = (version: number): void => {
    const snapshot = frame(wt, version)
    const decision = decideWebSessionTabsSnapshot(snapshot, env)
    applyWebSessionTabsStorePatch(
      (state) => (decision.apply ? applyWebSessionTabsSnapshot(state, snapshot, env) : state),
      { frames: [{ environmentId: env, worktreeId: wt, source: snapshot, decision }] }
    )()
  }
  const strip = (): string[] => {
    const state = useAppStore.getState()
    return (state.groupsByWorktree[wt] ?? [])
      .flatMap((group) => group.tabOrder)
      .map(
        (id) =>
          state.unifiedTabsByWorktree[wt]
            ?.find((tab) => tab.id === id)
            ?.entityId.slice(wt.length + 1) ?? id
      )
  }
  revision.replaceRuntimeEnvironmentRevisions([{ id: env, createdAt: 0, pairingRevision: 3 }])
  try {
    expect(requested).not.toHaveBeenCalled()
    apply(1)
    const ticket = intent.beginWebSessionCloseIntent(
      { environmentId: env },
      wt,
      closedId,
      Date.now()
    )
    if (!ticket) {
      throw new Error('missing close ticket')
    }
    expect(ticket.placement).toBeDefined()
    expect(ticket.owner.pairingRevision).toBe(3)
    const alias =
      scenario === 'aliases' || scenario === 'alias-overlap'
        ? intent.beginWebSessionCloseIntent(
            { environmentId: env },
            wt,
            `client:${wt}-b`,
            Date.now()
          )
        : null
    if (alias) {
      expect(alias.placement).toBeUndefined()
    }
    const tickets = alias ? [alias, ticket] : [ticket]
    apply(2)
    expect(strip()).toEqual(['a', 'c'])
    const reread = vi.fn(async (_acceptCurrent: boolean) => {
      if (scenario === 'reread-throw') {
        throw new Error('reread bookkeeping failed')
      }
    })
    const result = settleHostSessionTabClose({
      tickets: () => tickets,
      close: Promise.reject(new Error('offline')),
      reread,
      readAfterClose: false
    })
    await expect(result).resolves.toBe('failed')
    expect(
      intent.isWebSessionCloseIntentPending({ environmentId: env }, wt, closedId, Date.now())
    ).toBe(false)
    for (const original of tickets) {
      expect(
        intent.isWebSessionCloseIntentPending(original.owner, wt, original.closedId, Date.now())
      ).toBe(false)
    }
    await vi.waitFor(() => expect(requested).toHaveBeenCalledOnce())
    expect(reread).toHaveBeenCalledWith(true)
    expect(project).not.toHaveBeenCalled()
    expect(strip()).toEqual(['a', 'c'])
    let newer: WebSessionCloseIntentTicket | null = null
    const reorder = (order: string[]): void => {
      const state = useAppStore.getState()
      const ids = order.map((id) => {
        const tab = state.unifiedTabsByWorktree[wt].find((row) => row.entityId === `${wt}-${id}`)
        if (!tab) {
          throw new Error(`missing ${id}`)
        }
        return tab.id
      })
      useAppStore.setState({
        groupsByWorktree: {
          ...state.groupsByWorktree,
          [wt]: state.groupsByWorktree[wt].map((group) => ({ ...group, tabOrder: ids }))
        },
        tabBarOrderByWorktree: { ...state.tabBarOrderByWorktree, [wt]: ids }
      })
    }
    if (scenario === 'reclose') {
      newer = intent.beginWebSessionCloseIntent({ environmentId: env }, wt, closedId, Date.now())
      expect(newer?.entry).not.toBe(ticket.entry)
    } else if (scenario === 'repair') {
      revision.replaceRuntimeEnvironmentRevisions([{ id: env, createdAt: 0, pairingRevision: 4 }])
      expect(revision.getRuntimeEnvironmentRevision(env)).toBe(4)
    } else if (scenario === 'healthy') {
      apply(3)
      reorder(['a', 'c', 'b'])
    } else if (scenario === 'publisher') {
      recordReceivedWebSessionTabsSnapshot(env, {
        ...frame(wt, 3),
        publicationEpoch: 'new-publisher'
      })
    } else if (scenario === 'removed') {
      clearWebSessionTabsTrackingForWorktree(env, wt)
    } else if (scenario === 'anchors') {
      reorder(['c', 'a'])
    } else if (scenario === 'overlap' || scenario === 'alias-overlap') {
      apply(3)
      reorder(['c', 'b', 'a'])
      newer = intent.beginWebSessionCloseIntent({ environmentId: env }, wt, closedId, Date.now())
      if (!newer) {
        throw new Error('missing newer ticket')
      }
      expect(newer.placement?.previousTabId).not.toBe(ticket.placement?.previousTabId)
      expect(newer.placement?.nextTabId).not.toBe(ticket.placement?.nextTabId)
      apply(4)
      expect(strip()).toEqual(['c', 'a'])
      const newerTicket = newer
      await expect(
        settleHostSessionTabClose({
          tickets: () => [newerTicket],
          close: Promise.reject(new Error('second offline')),
          reread,
          readAfterClose: false
        })
      ).resolves.toBe('failed')
      expect(
        intent.isWebSessionCloseIntentPending({ environmentId: env }, wt, closedId, Date.now())
      ).toBe(false)
      expect(project).not.toHaveBeenCalled()
    }
    release()
    if (scenario === 'reject') {
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          '[session-tabs] could not load closed tab recovery',
          expect.objectContaining({
            cause: expect.objectContaining({ message: 'cold recovery module unavailable' })
          })
        )
      )
      expect(intent.isFailedWebSessionCloseIntents([ticket], Date.now())).toBe(
        scenario === 'reject'
      )
      expect(project).not.toHaveBeenCalled()
    } else if (scenario === 'reclose' || scenario === 'removed') {
      await vi.waitFor(() => expect(loaded).toHaveBeenCalledOnce())
      expect(intent.isFailedWebSessionCloseIntents([ticket], Date.now())).toBe(false)
    } else if (scenario === 'overlap' || scenario === 'alias-overlap') {
      await vi.waitFor(() => expect(strip()).toEqual(['c', 'b', 'a']))
    } else {
      await vi.waitFor(() => expect(project).toHaveBeenCalledOnce())
    }
    if (scenario === 'healthy') {
      expect(strip()).toEqual(['a', 'c', 'b'])
      expect(
        useAppStore.getState().unifiedTabsByWorktree[wt].find((tab) => tab.entityId === `${wt}-b`)
          ?.label
      ).toBe('b-3')
      expect(project).toHaveBeenCalledWith(ticket)
    } else if (scenario === 'overlap' || scenario === 'alias-overlap') {
      expect(strip()).toEqual(['c', 'b', 'a'])
      const recovered = take.mock.calls.filter(
        (_, index) => take.mock.results[index].value === true
      )
      expect(recovered).toHaveLength(1)
      expect(recovered[0]?.[0]).toEqual([newer])
      expect(project).not.toHaveBeenCalledWith(ticket)
      expect(
        useAppStore.getState().unifiedTabsByWorktree[wt].find((tab) => tab.entityId === `${wt}-b`)
          ?.label
      ).toBe('b-4')
    } else if (scenario === 'aliases' || scenario === 'reread-throw') {
      expect(strip()).toEqual(['a', 'b', 'c'])
      expect(project).toHaveBeenCalledWith(ticket)
      expect(project).not.toHaveBeenCalledWith(alias)
    } else if (scenario === 'anchors') {
      expect(strip()).toEqual(['b', 'c', 'a'])
      expect(
        useAppStore.getState().unifiedTabsByWorktree[wt].find((tab) => tab.entityId === `${wt}-b`)
          ?.label
      ).toBe('b-2')
    } else {
      expect(strip()).toEqual(['a', 'c'])
    }
    if (scenario === 'reclose') {
      expect(project).not.toHaveBeenCalled()
      expect(
        intent.isWebSessionCloseIntentPending({ environmentId: env }, wt, closedId, Date.now())
      ).toBe(true)
    }
    if (scenario === 'repair') {
      expect(revision.getRuntimeEnvironmentRevision(env)).toBe(4)
      expect(ticket.owner.pairingRevision).toBe(3)
    }
    if (scenario === 'reread-throw') {
      expect(warn).toHaveBeenCalledWith(
        '[session-tabs] tab re-read after a close failed',
        expect.objectContaining({ message: 'reread bookkeeping failed' })
      )
    }
    if (scenario === 'throw') {
      expect(warn).toHaveBeenCalledWith(
        '[session-tabs] could not restore closed tab from its host source',
        expect.objectContaining({ message: 'restore bookkeeping failed' })
      )
      expect(
        intent.isWebSessionCloseIntentPending({ environmentId: env }, wt, closedId, Date.now())
      ).toBe(false)
    }
  } finally {
    release()
    intent.resetWebSessionCloseIntentForTests()
    resetWebSessionTabsSnapshotFreshnessForTests()
    revision.replaceRuntimeEnvironmentRevisions([])
    useAppStore.setState(initial, true)
    vi.doUnmock('./host-session-tab-source-projection')
    vi.restoreAllMocks()
  }
})
