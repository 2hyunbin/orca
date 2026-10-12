import {
  setHostSessionTabIdMapping,
  clearHostSessionTabIdMappings
} from './web-session-tabs-sync/tracking-mappings'
// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import {
  beginWebSessionCloseIntent,
  resetWebSessionCloseIntentForTests
} from './web-session-close-intent'

afterEach(() => {
  resetWebSessionCloseIntentForTests()
  vi.restoreAllMocks()
})

it('loads close records before store creation and reports an unavailable placement reader', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const ticket = beginWebSessionCloseIntent(
    { environmentId: 'initializing', pairingRevision: 1 },
    'wt',
    'b',
    Date.now()
  )
  expect(ticket).not.toBeNull()
  expect(warn).toHaveBeenCalledWith(
    '[session-tabs] could not capture closed tab position',
    expect.objectContaining({ message: 'closed tab placement state reader is not registered' })
  )
})

it('registers the actual completed store and reads current occurrence placement on each close', async () => {
  const { useAppStore } = await import('../store')
  const initial = useAppStore.getState()
  const wt = 'reader-workspace'
  try {
    const tabs = ['a', 'b', 'c'].map(
      (id, index) =>
        ({
          id,
          worktreeId: wt,
          groupId: 'group',
          contentType: 'agent-session',
          entityId: id,
          label: id,
          sortOrder: index,
          createdAt: 0,
          isPreview: false,
          isPinned: false,
          customLabel: null,
          color: null
        }) satisfies Tab
    )
    useAppStore.setState({
      unifiedTabsByWorktree: { [wt]: tabs },
      groupsByWorktree: {
        [wt]: [{ id: 'group', worktreeId: wt, tabOrder: ['a', 'b', 'c'], activeTabId: 'c' }]
      },
      tabBarOrderByWorktree: { [wt]: ['a', 'b', 'c'] }
    })
    const owner = { environmentId: 'completed', pairingRevision: 1 }
    setHostSessionTabIdMapping(
      { environmentId: owner.environmentId, worktreeId: wt, tabId: 'b' },
      'host-b',
      'group'
    )
    const first = beginWebSessionCloseIntent(owner, wt, 'host-b', Date.now())
    expect(first?.placement).toMatchObject({
      localTabId: 'b',
      groupId: 'group',
      previousTabId: 'a',
      nextTabId: 'c',
      previousBarId: 'a',
      nextBarId: 'c'
    })
    useAppStore.setState({
      groupsByWorktree: {
        [wt]: [{ id: 'group', worktreeId: wt, tabOrder: ['c', 'b', 'a'], activeTabId: 'c' }]
      },
      tabBarOrderByWorktree: { [wt]: ['c', 'b', 'a'] }
    })
    const second = beginWebSessionCloseIntent(owner, wt, 'host-b', Date.now())
    expect(second?.placement).toMatchObject({
      previousTabId: 'c',
      nextTabId: 'a',
      previousBarId: 'c',
      nextBarId: 'a'
    })
    expect(first?.placement?.previousTabId).toBe('a')
  } finally {
    clearHostSessionTabIdMappings('completed', wt)
    useAppStore.setState(initial, true)
  }
})
