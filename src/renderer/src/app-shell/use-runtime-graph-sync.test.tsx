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

import { graphState } from '../runtime/sync-runtime-graph/graph-state'
import { useRuntimeGraphSync } from './use-runtime-graph-sync'

const initialState = useAppStore.getState()
const CLI_ID = 'repo1::/cli'
const SECOND_CLI = makeWorktree({
  id: 'repo1::/cli-2',
  repoId: 'repo1',
  path: '/cli-2',
  cliProvenance: { kind: 'created-by-cli', createdAt: 0 }
})

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
            id: CLI_ID,
            repoId: 'repo1',
            path: '/cli',
            cliProvenance: { kind: 'created-by-cli', createdAt: 0 }
          })
        ]
      }
    })
  })

  afterEach(() => {
    graphState.publishedNotificationHiddenWorkspaces = null
    useAppStore.setState(initialState, true)
  })

  it('republishes when the notification-hidden contents change, not when only inputs are replaced', () => {
    const { unmount } = renderHook(() => useRuntimeGraphSync())
    act(() => {
      useAppStore.setState({ activeWorktreeId: CLI_ID })
    })
    expect(mocks.scheduleRuntimeGraphSync).not.toHaveBeenCalled()

    act(() => {
      useAppStore.setState({ hideCliCreatedWorkspaces: true })
    })
    expect(mocks.scheduleRuntimeGraphSync).toHaveBeenCalledTimes(1)
    // What the scheduled sync would record once main accepts it.
    graphState.publishedNotificationHiddenWorkspaces = new Set([CLI_ID])

    // A replaced worktree list with the same hidden rows schedules nothing.
    act(() => {
      useAppStore.setState({ worktreesByRepo: { ...useAppStore.getState().worktreesByRepo } })
    })
    expect(mocks.scheduleRuntimeGraphSync).toHaveBeenCalledTimes(1)

    // A second CLI-created workspace changes the contents.
    act(() => {
      useAppStore.setState({
        worktreesByRepo: { repo1: [...useAppStore.getState().worktreesByRepo.repo1, SECOND_CLI] }
      })
    })
    expect(mocks.scheduleRuntimeGraphSync).toHaveBeenCalledTimes(2)
    unmount()
  })
})
