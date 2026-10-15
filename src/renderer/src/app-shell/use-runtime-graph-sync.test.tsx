// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { getDefaultNotificationSettings } from '../../../shared/notification-settings-defaults'
import { makeWorktree, TEST_REPO } from '../store/slices/worktrees-slice-test-fixtures'
import { useAppStore } from '../store'

const mocks = vi.hoisted(() => ({ scheduleRuntimeGraphSync: vi.fn() }))

vi.mock('../runtime/sync-runtime-graph', () => ({
  canSkipRuntimeMobileSessionSyncKeyBuild: () => true,
  getRuntimeMobileSessionSyncKey: () => ({ systemPrefersDark: false }),
  runtimeMobileSessionSyncKeysEqual: () => true,
  scheduleRuntimeGraphSync: mocks.scheduleRuntimeGraphSync,
  setRuntimeGraphStoreStateGetter: vi.fn(),
  setRuntimeGraphSyncEnabled: vi.fn()
}))

import { useRuntimeGraphSync } from './use-runtime-graph-sync'

const initialState = useAppStore.getState()

describe('useRuntimeGraphSync', () => {
  beforeEach(() => {
    mocks.scheduleRuntimeGraphSync.mockReset()
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/tmp'),
        notifications: { ...getDefaultNotificationSettings(), notifyHiddenWorkspaces: false }
      },
      persistedUIReady: true,
      repos: [TEST_REPO],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: 'repo1::/cli',
            repoId: 'repo1',
            cliProvenance: { kind: 'created-by-cli', createdAt: 0 }
          })
        ]
      }
    })
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it('republishes when the notification-hidden set changes, not on unrelated writes', () => {
    const { unmount } = renderHook(() => useRuntimeGraphSync())
    act(() => {
      useAppStore.setState({ activeWorktreeId: 'repo1::/cli' })
    })
    expect(mocks.scheduleRuntimeGraphSync).not.toHaveBeenCalled()

    act(() => {
      useAppStore.setState({ hideCliCreatedWorkspaces: true })
    })
    expect(mocks.scheduleRuntimeGraphSync).toHaveBeenCalledTimes(1)

    // A new worktree list with the same hidden rows is not a change.
    act(() => {
      useAppStore.setState({ worktreesByRepo: { ...useAppStore.getState().worktreesByRepo } })
    })
    expect(mocks.scheduleRuntimeGraphSync).toHaveBeenCalledTimes(1)
    unmount()
  })
})
