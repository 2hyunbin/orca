import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabAppearance } from '../../../../shared/runtime-types'
import { createTestStore, makeWorktree, seedStore } from '../../store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '../../store/slices/store-session-test-harness'
import { buildMobileSessionTabSnapshots } from '@/runtime/sync-runtime-graph/mobile-session-snapshots'

const { storeRef } = vi.hoisted(() => {
  const ref: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return { storeRef: ref }
})

function testStore(): ReturnType<typeof createTestStore> {
  if (!storeRef.current) {
    throw new Error('test store not created')
  }
  return storeRef.current
}

vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => testStore().getState(),
    subscribe: (...args: Parameters<ReturnType<typeof createTestStore>['subscribe']>) =>
      testStore().subscribe(...args),
    setState: (...args: Parameters<ReturnType<typeof createTestStore>['setState']>) =>
      testStore().setState(...args)
  }
}))

import { registerSessionTabIpcBridge } from './session-tab-ipc-bridge'

type Payload = { worktreeId: string } & RuntimeMobileSessionTabAppearance
const WORKTREE = 'repo1::/repo1/wt'

function setup(): { setProps: (payload: Payload) => void; tabId: string } {
  let setProps: ((payload: Payload) => void) | undefined
  vi.stubGlobal('window', {
    api: {
      ...createStoreSessionMockApi(),
      ui: {
        onCloseSessionTab: () => () => {},
        onSessionTabCloseRequest: () => () => {},
        onMoveSessionTab: () => () => {},
        onSetSessionTabAppearance: (cb: (payload: Payload) => void) => {
          setProps = cb
          return () => {}
        }
      }
    }
  })
  const store = createTestStore()
  storeRef.current = store
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/repo1/wt' })] }
  })
  const tab = store.getState().createTab(WORKTREE)
  registerSessionTabIpcBridge([])
  if (!setProps) {
    throw new Error('setSessionTabAppearance listener was not registered')
  }
  return { setProps, tabId: tab.id }
}

function phoneTab(tabId: string): { color?: string | null; isPinned?: boolean } | undefined {
  const snapshot = buildMobileSessionTabSnapshots(testStore().getState(), false).find(
    (candidate) => candidate.worktree === WORKTREE
  )
  const tab = snapshot?.tabs.find((candidate) =>
    candidate.type === 'terminal' ? candidate.parentTabId === tabId : candidate.id === tabId
  )
  return tab && 'color' in tab ? { color: tab.color, isPinned: tab.isPinned } : tab
}

describe("a phone's tab pin and color on the desktop window", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('applies to the window tab and is published back to the phone', () => {
    const { setProps, tabId } = setup()

    setProps({ worktreeId: WORKTREE, tabId, color: '#ff8800', isPinned: true })

    const state = testStore().getState()
    const unified = state.unifiedTabsByWorktree[WORKTREE]?.find((tab) => tab.entityId === tabId)
    expect(unified).toMatchObject({ color: '#ff8800', isPinned: true })
    expect(state.tabsByWorktree[WORKTREE]?.find((tab) => tab.id === tabId)?.color).toBe('#ff8800')
    expect(phoneTab(tabId)).toMatchObject({ color: '#ff8800', isPinned: true })

    setProps({ worktreeId: WORKTREE, tabId, color: null, isPinned: false })

    expect(phoneTab(tabId)).toMatchObject({ color: null, isPinned: false })
  })
})
