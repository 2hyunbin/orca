import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { getIndexedAllWorktrees, getIndexedRepoMap } from '@/store/worktree-repo-index'
import { getDefaultSettings } from '../../../shared/constants'
import { ALL_EXECUTION_HOSTS_SCOPE } from '../../../shared/execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { getDefaultNotificationSettings } from '../../../shared/notification-settings-defaults'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../shared/workspace-scope'
import { isFolderWorkspaceFromOtherDevice } from '../../../shared/workspace-creator-visibility'
import type { Worktree } from '../../../shared/worktree/types'
import { sidebarHasActiveFilters } from '@/components/sidebar/sidebar-filter-actions'
import { computeVisibleWorktreeIds } from '@/components/sidebar/compute-visible-worktrees'
import { buildVisibleWorktreeOptionsFromState } from '@/components/sidebar/visible-worktree-options-from-state'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import { createTestStore, makeWorktree, TEST_REPO } from '../store/slices/store-test-helpers'
import { getNotificationHiddenWorkspaceIds } from './hidden-workspace-notification-mute'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

createTabsSliceMockApi()

/** The per-workspace predicate as it shipped before the set existed, kept as the oracle. */
function legacyMuted(state: AppState, workspaceId: string): boolean {
  if (
    state.settings?.notifications?.notifyHiddenWorkspaces !== false ||
    !state.persistedUIReady ||
    !state.workspaceSessionReady ||
    !sidebarHasActiveFilters(state)
  ) {
    return false
  }
  const repoMap = getIndexedRepoMap(state.repos)
  const inputs = buildVisibleWorktreeOptionsFromState(state, repoMap)
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    const folder = state.folderWorkspaces.find((item) => item.id === scope.folderWorkspaceId)
    return (
      folder !== undefined &&
      inputs.hideWorkspacesFromOtherDevices &&
      isFolderWorkspaceFromOtherDevice(folder, inputs.pairedDeviceIdsByEnvironment)
    )
  }
  const known = getIndexedAllWorktrees(state.worktreesByRepo).some(
    (worktree) => worktree.id === workspaceId && !worktree.isArchived
  )
  if (!known) {
    return false
  }
  const visibleIds = computeVisibleWorktreeIds(state.worktreesByRepo, [], {
    ...inputs,
    filterRepoIds: [],
    workspaceHostScope: ALL_EXECUTION_HOSTS_SCOPE,
    visibleWorkspaceHostIds: null
  })
  return !visibleIds.includes(workspaceId)
}

const rows: Worktree[] = [
  makeWorktree({ id: 'repo1::/main', repoId: 'repo1', path: '/main', isMainWorktree: true }),
  makeWorktree({
    id: 'repo1::/cli',
    repoId: 'repo1',
    path: '/cli',
    instanceId: 'cli',
    cliProvenance: { kind: 'created-by-cli', createdAt: 0 }
  }),
  makeWorktree({
    id: 'repo1::/child',
    repoId: 'repo1',
    path: '/child',
    instanceId: 'child',
    cliProvenance: { kind: 'created-by-cli', createdAt: 0 }
  }),
  makeWorktree({ id: 'repo1::/detached', repoId: 'repo1', path: '/detached', branch: '' }),
  makeWorktree({
    id: 'repo1::/automation',
    repoId: 'repo1',
    path: '/automation',
    automationProvenance: {
      kind: 'created-by-automation',
      automationId: 'a',
      automationNameSnapshot: 'a',
      automationRunId: 'r',
      automationRunTitleSnapshot: 'r',
      createdAt: 0,
      executionTargetType: 'local',
      executionTargetId: 'local',
      projectId: 'p'
    }
  }),
  makeWorktree({
    id: 'repo1::/phone',
    repoId: 'repo1',
    path: '/phone',
    creatorProvenance: { kind: 'paired-device', deviceId: 'phone' }
  }),
  makeWorktree({ id: 'repo1::/plain', repoId: 'repo1', path: '/plain' }),
  makeWorktree({
    id: 'repo1::/archived',
    repoId: 'repo1',
    path: '/archived',
    isArchived: true,
    cliProvenance: { kind: 'created-by-cli', createdAt: 0 }
  })
]

function folder(id: string, deviceId: string | null): FolderWorkspace {
  return {
    id,
    projectGroupId: 'g1',
    name: id,
    folderPath: `/${id}`,
    ...(deviceId ? { creatorProvenance: { kind: 'paired-device' as const, deviceId } } : {}),
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

const queries = [
  ...rows.map((row) => row.id),
  'repo1::/unknown',
  'worktree:repo1::/cli',
  folderWorkspaceKey('f-phone'),
  folderWorkspaceKey('f-own'),
  folderWorkspaceKey('f-unknown')
]

const SWITCHES = [
  'hideDefaultBranchWorkspace',
  'hideAutomationGeneratedWorkspaces',
  'hideCliCreatedWorkspaces',
  'hideDetachedHeadWorkspaces',
  'hideWorkspacesFromOtherDevices'
] as const

let store: ReturnType<typeof createTestStore>

function setNotifyHiddenWorkspaces(notifyHiddenWorkspaces: boolean): void {
  store.setState({
    settings: {
      ...getDefaultSettings('/tmp'),
      notifications: { ...getDefaultNotificationSettings(), notifyHiddenWorkspaces }
    }
  })
}

function expectSetMatchesLegacy(): void {
  const state = store.getState()
  const hidden = getNotificationHiddenWorkspaceIds(state)
  for (const id of queries) {
    expect({ id, muted: hidden.has(id) }).toEqual({ id, muted: legacyMuted(state, id) })
  }
  // A second read is the memoized answer and must not differ.
  expect(getNotificationHiddenWorkspaceIds(store.getState())).toEqual(hidden)
}

beforeEach(() => {
  store = createTestStore()
  store.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { repo1: rows },
    folderWorkspaces: [folder('f-phone', 'phone'), folder('f-own', null)],
    persistedUIReady: true,
    workspaceSessionReady: true
  })
  setNotifyHiddenWorkspaces(false)
})

describe('getNotificationHiddenWorkspaceIds matches the per-workspace predicate it replaced', () => {
  it('with no switch on', () => {
    expectSetMatchesLegacy()
  })

  for (const name of SWITCHES) {
    it(`with ${name} alone`, () => {
      store.setState({ [name]: true })
      expectSetMatchesLegacy()
      store.setState({ [name]: false })
      expectSetMatchesLegacy()
    })
  }

  it('with every switch on, and again after each turns off', () => {
    store.setState(Object.fromEntries(SWITCHES.map((name) => [name, true])))
    expectSetMatchesLegacy()
    // Presence precondition: the matrix exercises rows and folders the switches really hide.
    expect([...getNotificationHiddenWorkspaceIds(store.getState())].sort()).toEqual([
      'folder:f-phone',
      'repo1::/automation',
      'repo1::/child',
      'repo1::/cli',
      'repo1::/detached',
      'repo1::/main',
      'repo1::/phone'
    ])
    for (const name of SWITCHES) {
      store.setState({ [name]: false })
      expectSetMatchesLegacy()
    }
  })

  it('with Hide sleeping, with and without a live terminal', () => {
    store.setState({ showSleepingWorkspaces: false })
    expectSetMatchesLegacy()
    store.setState({
      tabsByWorktree: {
        'repo1::/plain': [
          {
            id: 'tab-plain',
            ptyId: 'pty-1',
            worktreeId: 'repo1::/plain',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      ptyIdsByTabId: { 'tab-plain': ['pty-1'] }
    })
    expectSetMatchesLegacy()
    store.setState({ alwaysShowDefaultBranchWorkspace: false })
    expectSetMatchesLegacy()
  })

  it('with a hidden lineage parent above a visible child', () => {
    store.setState({
      hideCliCreatedWorkspaces: true,
      worktreesByRepo: {
        repo1: rows.map((row) =>
          row.id === 'repo1::/child' ? { ...row, cliProvenance: undefined } : row
        )
      },
      worktreeLineageById: {
        'repo1::/child': {
          worktreeId: 'repo1::/child',
          worktreeInstanceId: 'child',
          parentWorktreeId: 'repo1::/cli',
          parentWorktreeInstanceId: 'cli',
          origin: 'cli',
          capture: { source: 'terminal-context', confidence: 'inferred' },
          createdAt: 1
        }
      }
    })
    expectSetMatchesLegacy()
    store.setState({ sortBy: 'manual' })
    expectSetMatchesLegacy()
  })

  it('with a same-id twin on another host that the switches show', () => {
    store.setState({
      hideCliCreatedWorkspaces: true,
      worktreesByRepo: {
        repo1: rows,
        'repo1@other-host': [
          makeWorktree({ id: 'repo1::/cli', repoId: 'repo1', path: '/cli', hostId: 'ssh:other' })
        ]
      }
    })
    expectSetMatchesLegacy()
  })

  it('with only the project or host filter active', () => {
    store.setState({ filterRepoIds: ['other-repo'] })
    expectSetMatchesLegacy()
    store.setState({ filterRepoIds: [], visibleWorkspaceHostIds: ['local'] })
    expectSetMatchesLegacy()
  })

  it('before hydration, before terminals reconnect, and with hidden workspaces notifying', () => {
    store.setState({ hideCliCreatedWorkspaces: true, hideDefaultBranchWorkspace: true })
    expectSetMatchesLegacy()
    store.setState({ persistedUIReady: false })
    expectSetMatchesLegacy()
    store.setState({ persistedUIReady: true, workspaceSessionReady: false })
    expectSetMatchesLegacy()
    store.setState({ workspaceSessionReady: true, settings: null })
    expectSetMatchesLegacy()
    setNotifyHiddenWorkspaces(true)
    expectSetMatchesLegacy()
  })
})
