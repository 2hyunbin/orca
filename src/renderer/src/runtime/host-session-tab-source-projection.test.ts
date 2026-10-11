// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { useAppStore } from '../store'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { decideWebSessionTabsSnapshot } from './web-session-tabs-sync/tracking-decisions'
import { applyWebSessionTabsStorePatch } from './web-session-tabs-sync/store-patch'
import {
  resetWebSessionTabsSnapshotFreshnessForTests,
  clearWebSessionTabsTrackingForWorktree
} from './web-session-tabs-sync/tracking-lifecycle'
import { applyStructuredSessionTabSnapshots } from './local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from './local-structured-session-tabs-sync/inventory-generation-fence'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { recordReceivedWebSessionTabsSnapshot } from './web-session-tabs-sync/tracking'
import {
  beginWebSessionCloseIntent,
  isWebSessionCloseIntentPending,
  resetWebSessionCloseIntentForTests,
  settleWebSessionCloseIntent
} from './web-session-close-intent'
import { rereadHostSessionTabs, settleHostSessionTabClose } from './host-session-tab-close'
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import { makeWorktree } from './host-session-mirror-frame-fixtures'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'

vi.mock('./web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: async () => {
    throw new Error('offline')
  }
}))
vi.mock('./local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionWorktreeTabs: async () => {
    throw new Error('offline')
  }
}))

let WT = 'folder-workspace'
const ENV = 'paired-host'
const initial = useAppStore.getState()
const otherEnvironment = {
  id: 'other-host',
  name: 'other',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [],
  preferredEndpointId: 'other'
}

function frame(version = 1, ids = ['a', 'b', 'c']): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'epoch',
    snapshotVersion: version,
    activeGroupId: 'group',
    activeTabId: 'agent-session:a',
    activeTabType: 'agent-session',
    tabs: ids.map((sessionId) => ({
      type: 'agent-session',
      id: `agent-session:${sessionId}`,
      sessionId,
      title: `${sessionId}-${version}`,
      agent: 'codex',
      isActive: sessionId === 'a'
    })),
    tabGroups: [
      {
        id: 'group',
        tabOrder: ids.map((id) => `agent-session:${id}`),
        activeTabId: 'agent-session:a'
      }
    ]
  }
}

function apply(snapshot: RuntimeMobileSessionTabsResult, local = false): void {
  if (local) {
    applyStructuredSessionTabSnapshots([snapshot])
  } else {
    const decision = decideWebSessionTabsSnapshot(snapshot, ENV)
    applyWebSessionTabsStorePatch(
      (state) => (decision.apply ? applyWebSessionTabsSnapshot(state, snapshot, ENV) : state),
      { frames: [{ environmentId: ENV, worktreeId: WT, source: snapshot, decision }] }
    )()
  }
}

function localId(sessionId: string): string {
  const tab = useAppStore
    .getState()
    .unifiedTabsByWorktree[WT]?.find((candidate) => candidate.entityId === sessionId)
  if (!tab) {
    throw new Error(`missing ${sessionId}`)
  }
  return tab.id
}

function strip(): string[] {
  const state = useAppStore.getState()
  return (state.groupsByWorktree[WT] ?? [])
    .flatMap((group) => group.tabOrder)
    .map((id) => state.unifiedTabsByWorktree[WT]?.find((tab) => tab.id === id)?.entityId ?? id)
}

function prune(sessionId: string): void {
  const id = localId(sessionId)
  useAppStore.setState((state) => ({
    unifiedTabsByWorktree: {
      ...state.unifiedTabsByWorktree,
      [WT]: state.unifiedTabsByWorktree[WT].filter((tab) => tab.id !== id)
    },
    groupsByWorktree: {
      ...state.groupsByWorktree,
      [WT]: state.groupsByWorktree[WT].map((group) => ({
        ...group,
        tabOrder: group.tabOrder.filter((tabId) => tabId !== id)
      }))
    },
    tabBarOrderByWorktree: {
      ...state.tabBarOrderByWorktree,
      [WT]: (state.tabBarOrderByWorktree[WT] ?? []).filter((tabId) => tabId !== id)
    }
  }))
}

function start(local = false) {
  const environmentId = local ? LOCAL_STRUCTURED_SESSION_OWNER : ENV
  const ticket = beginWebSessionCloseIntent({ environmentId }, WT, 'agent-session:b', Date.now())!
  prune('b')
  const reread = vi.fn((acceptCurrent: boolean) =>
    rereadHostSessionTabs(
      local ? { kind: 'local' } : { kind: 'environment', environmentId: ENV },
      WT,
      local ? undefined : 3,
      acceptCurrent
    )
  )
  const result = settleHostSessionTabClose({
    tickets: () => [ticket],
    close: new Promise(() => {}),
    reread,
    readAfterClose: false
  })
  return { ticket, result, reread }
}

beforeEach(() => {
  WT = 'folder-workspace'
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  replaceRuntimeEnvironmentRevisions([{ id: ENV, createdAt: 0, pairingRevision: 3 }])
  useAppStore.setState({
    activeWorktreeId: WT,
    activeWorkspaceExecutionHostId: null,
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: []
  })
})

afterEach(() => {
  resetWebSessionCloseIntentForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
  resetLocalStructuredSessionVersionForTests()
  replaceRuntimeEnvironmentRevisions([])
  useAppStore.setState(initial, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('failed host close projection', () => {
  it.each([false, true])(
    'ignores Active Server changes with a missing owner, local=%s',
    async (local) => {
      apply(frame(), local)
      const { result } = start(local)
      useAppStore.setState({
        settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'other-host' }),
        runtimeEnvironments: [otherEnvironment]
      })
      await vi.advanceTimersByTimeAsync(15_000)
      await result
      expect(strip()).toEqual(['a', 'b', 'c'])
      expect(useAppStore.getState().worktreesByRepo).toEqual({})
    }
  )

  it('keeps an unstamped catalog independent of Active Server', async () => {
    useAppStore.setState({
      worktreesByRepo: {
        'repo-1': [{ ...makeWorktree(WT, '/workspace/feature'), hostId: undefined }]
      },
      repos: [{ id: 'repo-1', path: '/workspace', displayName: 'repo', badgeColor: '', addedAt: 0 }]
    })
    apply(frame())
    const { result } = start()
    useAppStore.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'other-host' }),
      runtimeEnvironments: [otherEnvironment]
    })
    await vi.advanceTimersByTimeAsync(15_000)
    await result
    expect(strip()).toEqual(['a', 'b', 'c'])
  })

  it.each(['paired', 'ssh', 'ssh-repo', 'selected-ssh'] as const)(
    'restores by the explicit RPC owner: %s',
    async (kind) => {
      const row = {
        ...makeWorktree(WT, '/workspace/feature'),
        hostId: kind === 'paired' ? ('runtime:paired-host' as const) : ('ssh:target' as const),
        runtimeOwnerEnvironmentId: kind === 'ssh-repo' ? undefined : ENV
      }
      useAppStore.setState({
        worktreesByRepo: { 'repo-1': [row] },
        ...(kind === 'selected-ssh'
          ? { activeWorkspaceExecutionHostId: 'ssh:target' as const }
          : {}),
        ...(kind === 'ssh-repo'
          ? {
              repos: [
                {
                  id: 'repo-1',
                  connectionId: 'target',
                  executionHostId: 'runtime:paired-host',
                  displayName: 'repo',
                  path: '/workspace',
                  badgeColor: '',
                  addedAt: 0
                }
              ]
            }
          : {})
      })
      apply(frame())
      const { result } = start()
      useAppStore.setState({
        settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'other-host' }),
        runtimeEnvironments: [otherEnvironment]
      })
      await vi.advanceTimersByTimeAsync(15_000)
      await result
      expect(strip()).toEqual(['a', 'b', 'c'])
    }
  )

  it.each(['conflict', 'ambiguous', 'ssh-without-hub', 'local-ssh', 'selected-conflict'] as const)(
    'fences an incompatible explicit owner: %s',
    async (kind) => {
      const local = kind === 'local-ssh'
      apply(frame(), local)
      const { result } = start(local)
      const row = {
        ...makeWorktree(WT, '/workspace/feature'),
        hostId: 'ssh:target' as const,
        runtimeOwnerEnvironmentId:
          kind === 'ssh-without-hub' || local
            ? undefined
            : kind === 'selected-conflict'
              ? ENV
              : 'other-host'
      }
      useAppStore.setState({
        ...(kind === 'selected-conflict'
          ? { activeWorkspaceExecutionHostId: 'local' as const }
          : {}),
        worktreesByRepo: {
          'repo-1': kind === 'ambiguous' ? [row, { ...row, runtimeOwnerEnvironmentId: ENV }] : [row]
        }
      })
      await vi.advanceTimersByTimeAsync(15_000)
      await result
      expect(strip()).toEqual(['a', 'c'])
    }
  )

  it.each(['paired', 'project-group', 'local', 'conflict', 'ambiguous', 'ssh-local'] as const)(
    'checks folder owner correspondence: %s',
    async (kind) => {
      WT = 'folder:source-folder'
      const local = kind === 'local' || kind === 'ssh-local'
      const group: ProjectGroup = {
        id: 'source-group',
        name: 'group',
        parentPath: '/workspace',
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 0,
        updatedAt: 0,
        executionHostId: kind === 'project-group' ? 'runtime:paired-host' : null
      }
      const folder: FolderWorkspace = {
        id: 'source-folder',
        projectGroupId: group.id,
        name: 'folder',
        folderPath: '/workspace',
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        createdAt: 0,
        updatedAt: 0,
        executionHostId:
          kind === 'project-group'
            ? undefined
            : kind === 'local'
              ? 'local'
              : kind === 'ssh-local'
                ? 'local'
                : 'runtime:paired-host',
        connectionId: kind === 'paired' ? 'target' : null
      }
      useAppStore.setState({
        activeWorktreeId: WT,
        folderWorkspaces: [folder],
        projectGroups: [group]
      })
      apply(frame(), local)
      const { result } = start(local)
      useAppStore.setState({
        settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'other-host' }),
        runtimeEnvironments: [otherEnvironment],
        ...(kind === 'ssh-local'
          ? { folderWorkspaces: [{ ...folder, executionHostId: 'ssh:target' }] }
          : {}),
        ...(kind === 'conflict'
          ? { folderWorkspaces: [{ ...folder, executionHostId: 'runtime:other-host' }] }
          : {}),
        ...(kind === 'ambiguous'
          ? { folderWorkspaces: [folder, { ...folder, executionHostId: 'runtime:other-host' }] }
          : {})
      })
      await vi.advanceTimersByTimeAsync(15_000)
      await result
      expect(strip()).toEqual(
        ['conflict', 'ambiguous', 'ssh-local'].includes(kind) ? ['a', 'c'] : ['a', 'b', 'c']
      )
    }
  )

  it.each([false, true])(
    'restores original neighbors at the offline bound, local=%s',
    async (local) => {
      apply(frame(), local)
      expect(strip()).toEqual(['a', 'b', 'c'])
      const { result, reread } = start(local)
      expect(strip()).toEqual(['a', 'c'])
      await vi.advanceTimersByTimeAsync(15_000)
      await expect(result).resolves.toBe('failed')
      expect(strip()).toEqual(['a', 'b', 'c'])
      expect(reread).toHaveBeenCalledWith(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(strip()).toEqual(['a', 'b', 'c'])
    }
  )

  it('restores from newest source, preserving current sibling changes and focus', async () => {
    apply({ ...frame(), navigationIntent: 'follow' })
    const { result } = start()
    apply(frame(2, ['b', 'c', 'd']))
    const c = localId('c')
    useAppStore.setState((state) => ({
      activeTabIdByWorktree: { ...state.activeTabIdByWorktree, [WT]: c },
      groupsByWorktree: {
        ...state.groupsByWorktree,
        [WT]: state.groupsByWorktree[WT].map((group) => ({ ...group, activeTabId: c }))
      }
    }))
    await vi.advanceTimersByTimeAsync(15_000)
    await result
    expect(strip()).toEqual(['b', 'c', 'd'])
    expect(
      useAppStore.getState().unifiedTabsByWorktree[WT].find((tab) => tab.entityId === 'c')?.label
    ).toBe('c-2')
    expect(useAppStore.getState().groupsByWorktree[WT][0].activeTabId).toBe(c)
  })

  it('preserves recoverable chat facts in a newer unverifiable inventory', async () => {
    apply(frame())
    const { result } = start()
    apply({ ...frame(2, ['c']), agentSessionsUnverifiable: true })
    await vi.advanceTimersByTimeAsync(15_000)
    await result
    expect(strip()).toEqual(['a', 'b', 'c'])
  })

  it('does not turn cached replay into omission proof for another close', async () => {
    apply(frame())
    const { result } = start()
    const other = beginWebSessionCloseIntent(
      { environmentId: ENV },
      WT,
      'agent-session:new',
      Date.now()
    )!
    await vi.advanceTimersByTimeAsync(15_000)
    await result
    settleWebSessionCloseIntent(other, 'closed', Date.now())
    expect(
      isWebSessionCloseIntentPending({ environmentId: ENV }, WT, 'agent-session:new', Date.now())
    ).toBe(true)
  })

  it.each(['pairing', 'publisher', 'removed', 'owner'] as const)(
    'never restores an invalidated source: %s',
    async (invalidation) => {
      apply(frame())
      const { result } = start()
      if (invalidation === 'pairing') {
        replaceRuntimeEnvironmentRevisions([{ id: ENV, createdAt: 0, pairingRevision: 4 }])
      } else if (invalidation === 'publisher') {
        recordReceivedWebSessionTabsSnapshot(ENV, {
          ...frame(2),
          publicationEpoch: 'new-publisher'
        })
      } else if (invalidation === 'owner') {
        useAppStore.setState({ activeWorkspaceExecutionHostId: 'local' })
      } else {
        clearWebSessionTabsTrackingForWorktree(ENV, WT)
      }
      await vi.advanceTimersByTimeAsync(15_000)
      await result
      expect(strip()).toEqual(['a', 'c'])
    }
  )

  it('uses normal append when both original neighbors are gone', async () => {
    apply(frame())
    const { result } = start()
    apply(frame(2, ['b', 'd']))
    await vi.advanceTimersByTimeAsync(15_000)
    await result
    expect(strip()).toEqual(['d', 'b'])
  })
})
