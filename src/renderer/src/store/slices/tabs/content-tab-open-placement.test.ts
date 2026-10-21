import { describe, expect, it } from 'vitest'
import { createTestStore } from '../browser-slice-test-harness'
import { contentTabOpenPlacement } from './content-tab-open-placement'

describe('contentTabOpenPlacement', () => {
  it('places a tab in the first group of a store that holds no active-group map', () => {
    const store = createTestStore()
    store.setState({
      layoutByWorktree: {},
      groupsByWorktree: {
        'wt-1': [{ id: 'group-1', worktreeId: 'wt-1', activeTabId: null, tabOrder: [] }]
      }
    })
    expect('activeGroupIdByWorktree' in store.getState()).toBe(false)

    expect(contentTabOpenPlacement(store.getState(), 'wt-1', 'tab-1', {})).toMatchObject({
      groupId: 'group-1'
    })
  })
})
