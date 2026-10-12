import { projectHostSessionTabSource } from '../../../shared/host-session-snapshot'
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionTabsResult
} from '../../../shared/runtime-types'
import { useAppStore } from '../store'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { decideWebSessionTabsSnapshot } from './web-session-tabs-sync/tracking-decisions'
import { applyWebSessionTabsStorePatch } from './web-session-tabs-sync/store-patch'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  beginWebSessionCloseIntent,
  resetWebSessionCloseIntentForTests,
  settleWebSessionCloseIntent
} from './web-session-close-intent'
import { closeWebRuntimeSessionTab } from './web-runtime-session-tab-lifecycle'

const ENV = 'paired-host'
const WT = 'folder-workspace'
const initial = useAppStore.getState()

function apply(snapshot: RuntimeMobileSessionTabsResult): void {
  const decision = decideWebSessionTabsSnapshot(snapshot, ENV)
  applyWebSessionTabsStorePatch(
    (state) => (decision.apply ? applyWebSessionTabsSnapshot(state, snapshot, ENV) : state),
    { frames: [{ environmentId: ENV, worktreeId: WT, source: snapshot, decision }] }
  )()
}

function groups(): { id: string; order: string[] }[] {
  return (useAppStore.getState().groupsByWorktree[WT] ?? []).map((group) => ({
    id: group.id,
    order: group.tabOrder
  }))
}

function holdHostCloses() {
  const refusals: ((reason: Error) => void)[] = []
  const call = vi.fn((args: { method: string }) => {
    if (args.method === 'session.tabs.close') {
      return new Promise<RuntimeRpcResponse<unknown>>((_resolve, reject) => refusals.push(reject))
    }
    return Promise.resolve({
      id: 'offline',
      ok: false,
      error: { code: 'offline', message: 'offline' }
    } satisfies RuntimeRpcResponse<unknown>)
  })
  vi.stubGlobal('api', { runtimeEnvironments: { call } })
  return { call, refusals }
}

function browserFrame(version: number): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
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
      title: id,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isActive: false
    })),
    tabGroups: [{ id: 'group', tabOrder: ['host-a', 'host-b', 'host-c'], activeTabId: null }]
  }
}

function editorFrame(version: number): RuntimeMobileSessionTabsResult {
  const file = (id: string, document: string): RuntimeMobileSessionFileTab => ({
    type: 'file',
    id,
    filePath: `/tmp/${document}.ts`,
    relativePath: `${document}.ts`,
    language: 'typescript',
    isDirty: false,
    title: id,
    isActive: false
  })
  return {
    worktree: WT,
    publicationEpoch: 'editor-epoch',
    snapshotVersion: version,
    activeGroupId: 'g2',
    activeTabId: null,
    activeTabType: null,
    tabs: [file('a', 'a'), file('b1', 'b'), file('b2', 'b'), file('c', 'c')],
    tabGroups: [
      { id: 'g1', tabOrder: ['a', 'b1'], activeTabId: null },
      { id: 'g2', tabOrder: ['b2', 'c'], activeTabId: null }
    ]
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  replaceRuntimeEnvironmentRevisions([{ id: ENV, createdAt: 0, pairingRevision: 3 }])
  useAppStore.setState({ activeWorktreeId: WT })
})

afterEach(() => {
  resetWebSessionCloseIntentForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
  replaceRuntimeEnvironmentRevisions([])
  useAppStore.setState(initial, true)
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('host close occurrence and restoration identity', () => {
  it.each([false, true])(
    'reconciles recovery order before the store commit, already present=%s',
    (alreadyPresent) => {
      apply(browserFrame(1))
      const ticket = beginWebSessionCloseIntent({ environmentId: ENV }, WT, 'host-b', Date.now())!
      const placement = ticket.placement
      if (!placement) {
        throw new Error('missing close placement')
      }
      if (!alreadyPresent) {
        apply(browserFrame(2))
        expect(groups()[0].order).toEqual(['host-a', 'host-c'])
      }
      settleWebSessionCloseIntent(ticket, 'failed', Date.now())
      useAppStore.setState((state) => ({
        groupsByWorktree: {
          ...state.groupsByWorktree,
          [WT]: state.groupsByWorktree[WT].map((group) => ({
            ...group,
            activeTabId: 'host-c',
            ...(alreadyPresent ? { tabOrder: ['host-c', 'host-a', 'host-b'] } : {})
          }))
        },
        ...(alreadyPresent
          ? {
              tabBarOrderByWorktree: {
                ...state.tabBarOrderByWorktree,
                [WT]: ['host-c', 'host-a', 'host-b']
              }
            }
          : {})
      }))
      const state = useAppStore.getState()
      const patch = applyWebSessionTabsSnapshot(
        state,
        projectHostSessionTabSource(browserFrame(2)),
        ENV,
        Date.now(),
        {
          projectionOnly: true,
          closeRestoration: { ...placement, hostTabId: ticket.closedId }
        }
      )
      const expected = alreadyPresent
        ? ['host-c', 'host-a', 'host-b']
        : ['host-a', 'host-b', 'host-c']
      expect(patch.groupsByWorktree?.[WT][0].tabOrder).toEqual(expected)
      expect(patch.tabBarOrderByWorktree?.[WT] ?? state.tabBarOrderByWorktree[WT]).toEqual(expected)
      expect(patch.groupsByWorktree?.[WT][0].activeTabId).toBe('host-c')
      expect(groups()[0].order).toEqual(alreadyPresent ? expected : ['host-a', 'host-c'])
      applyWebSessionTabsStorePatch(() => patch, { frames: [] })()
      expect(groups()[0].order).toEqual(expected)
      expect(useAppStore.getState().tabBarOrderByWorktree[WT]).toEqual(expected)
    }
  )

  it.each(['rejection', 'timeout'] as const)(
    'restores an adopted browser between surviving neighbors after %s',
    async (outcome) => {
      apply(browserFrame(1))
      useAppStore.setState((state) => ({
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          [WT]: state.unifiedTabsByWorktree[WT].map((tab) =>
            tab.id === 'host-b' ? { ...tab, id: 'client-b' } : tab
          )
        },
        groupsByWorktree: {
          ...state.groupsByWorktree,
          [WT]: state.groupsByWorktree[WT].map((group) => ({
            ...group,
            tabOrder: group.tabOrder.map((id) => (id === 'host-b' ? 'client-b' : id))
          }))
        },
        tabBarOrderByWorktree: {
          ...state.tabBarOrderByWorktree,
          [WT]: state.tabBarOrderByWorktree[WT].map((id) => (id === 'host-b' ? 'client-b' : id))
        }
      }))
      apply(browserFrame(2))
      expect(groups()[0].order).toEqual(['host-a', 'client-b', 'host-c'])
      const { call, refusals } = holdHostCloses()
      const close = closeWebRuntimeSessionTab({
        worktreeId: WT,
        tabId: 'client-b',
        environmentId: ENV,
        reason: 'user'
      })
      // The user prune follows synchronously, before a host response or new inventory.
      useAppStore.setState((state) => ({
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          [WT]: state.unifiedTabsByWorktree[WT].filter((tab) => tab.id !== 'client-b')
        },
        groupsByWorktree: {
          ...state.groupsByWorktree,
          [WT]: state.groupsByWorktree[WT].map((group) => ({
            ...group,
            activeTabId: 'host-c',
            tabOrder: group.tabOrder.filter((id) => id !== 'client-b')
          }))
        },
        tabBarOrderByWorktree: {
          ...state.tabBarOrderByWorktree,
          [WT]: state.tabBarOrderByWorktree[WT].filter((id) => id !== 'client-b')
        }
      }))
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'session.tabs.close',
          params: expect.objectContaining({ tabId: 'host-b' })
        })
      )
      expect(refusals).toHaveLength(1)
      apply(browserFrame(3))
      expect(groups()[0].order).toEqual(['host-a', 'host-c'])
      if (outcome === 'rejection') {
        refusals[0]?.(new Error('offline'))
      } else {
        await vi.advanceTimersByTimeAsync(15_000)
      }
      await expect(close).resolves.toBe('failed')
      expect(groups()[0].order).toEqual(['host-a', 'host-b', 'host-c'])
      expect(useAppStore.getState().tabBarOrderByWorktree[WT]).toEqual([
        'host-a',
        'host-b',
        'host-c'
      ])
      expect(useAppStore.getState().groupsByWorktree[WT][0].activeTabId).toBe('host-c')
      await vi.advanceTimersByTimeAsync(0)
      expect(groups()[0].order).toEqual(['host-a', 'host-b', 'host-c'])
      if (outcome === 'timeout') {
        refusals[0]?.(new Error('late offline'))
      }
    }
  )

  it('restores two split editor occurrences sharing one document to their own groups', async () => {
    apply(editorFrame(1))
    const twins = useAppStore
      .getState()
      .unifiedTabsByWorktree[WT].filter((tab) => tab.id === 'b1' || tab.id === 'b2')
    expect(twins).toHaveLength(2)
    expect(twins[0]?.entityId).toBe(twins[1]?.entityId)
    const first = beginWebSessionCloseIntent({ environmentId: ENV }, WT, 'b1', Date.now())!
    const second = beginWebSessionCloseIntent({ environmentId: ENV }, WT, 'b2', Date.now())!
    expect(first.placement?.groupId).toBe('g1')
    expect(second.placement?.groupId).toBe('g2')
    const { refusals } = holdHostCloses()
    const closes = [first, second].map((ticket) =>
      closeWebRuntimeSessionTab({
        worktreeId: WT,
        tabId: ticket.closedId,
        reason: 'user',
        initialCloseTicket: ticket
      })
    )
    expect(refusals).toHaveLength(2)
    apply(editorFrame(2))
    expect(groups()).toEqual([
      { id: 'g1', order: ['a'] },
      { id: 'g2', order: ['c'] }
    ])
    refusals[0]?.(new Error('offline'))
    await closes[0]
    expect(groups()).toEqual([
      { id: 'g1', order: ['a', 'b1'] },
      { id: 'g2', order: ['c'] }
    ])
    refusals[1]?.(new Error('offline'))
    await closes[1]
    expect(groups()).toEqual([
      { id: 'g1', order: ['a', 'b1'] },
      { id: 'g2', order: ['b2', 'c'] }
    ])
    expect(
      useAppStore.getState().unifiedTabsByWorktree[WT].find((tab) => tab.id === 'b2')?.groupId
    ).toBe('g2')
  })
})
