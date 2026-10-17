/**
 * A local and a remote copy of one project can share the repo id and worktree path, so both
 * publish the same worktree id. Removing the remote copy must leave the local twin's shell,
 * tabs, unsaved document and drafts alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makeOpenFile,
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree
} from './store-test-helpers'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import type { BrowserWorkspace } from '../../../../shared/browser-workspace-types'
import type { Tab } from '../../../../shared/tab-types'
import type { ClosedEditorTabSnapshot } from './editor/types/open-file'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'

const PROJECT_ID = 'same-repo'
const WORKTREE_ID = 'same-repo::/work/same'
const REMOTE_HOST = 'runtime:env-b' as const
const localRow: Repo = {
  id: PROJECT_ID,
  path: '/work/same',
  displayName: 'Same',
  badgeColor: '#000',
  addedAt: 1,
  executionHostId: 'local'
}
const remoteRow: Repo = { ...localRow, executionHostId: REMOTE_HOST }
const remotePtyId = toRemoteRuntimePtyId('handle-1', 'env-b')

const ptyKill = vi.fn()
let onRepoRemoved: (() => void) | null = null

function browserWorkspace(id: string): BrowserWorkspace {
  return {
    id,
    worktreeId: WORKTREE_ID,
    url: 'about:blank',
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

function answerLikeRuntimeHost(args: RuntimeEnvironmentCallRequest): unknown {
  const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
  if (compatible) {
    return compatible
  }
  if (args.method === 'repo.rm') {
    onRepoRemoved?.()
  }
  return { id: args.method, ok: true, result: {}, _meta: { runtimeId: 'runtime-remote' } }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  ptyKill.mockReset()
  onRepoRemoved = null
  vi.stubGlobal('window', {
    api: {
      repos: { remove: vi.fn(), removeForHost: vi.fn().mockResolvedValue(undefined) },
      pty: { kill: ptyKill },
      runtimeEnvironments: {
        call: vi.fn(answerLikeRuntimeHost),
        list: vi.fn().mockResolvedValue([{ id: 'env-b' }])
      },
      ui: { set: vi.fn().mockResolvedValue(undefined) }
    }
  })
})

function closedSnapshot(filePath: string): ClosedEditorTabSnapshot {
  const {
    id: _id,
    isDirty: _dirty,
    ...snapshot
  } = makeOpenFile({
    id: filePath,
    worktreeId: WORKTREE_ID
  })
  return snapshot
}

function seedTwins(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  const localFileId = '/work/same/local.ts'
  const remoteFileId = 'editor:remote-file'
  store.setState({
    repos: [localRow, remoteRow],
    worktreesByRepo: {
      [PROJECT_ID]: [
        makeWorktree({ id: WORKTREE_ID, repoId: PROJECT_ID, hostId: 'local' }),
        makeWorktree({ id: WORKTREE_ID, repoId: PROJECT_ID, hostId: REMOTE_HOST })
      ]
    },
    tabsByWorktree: {
      [WORKTREE_ID]: [
        makeTab({ id: 'tab-local', worktreeId: WORKTREE_ID, ptyId: 'pty-local' }),
        makeTab({ id: 'tab-remote', worktreeId: WORKTREE_ID, ptyId: remotePtyId })
      ]
    },
    ptyIdsByTabId: { 'tab-local': ['pty-local'], 'tab-remote': [remotePtyId] },
    unifiedTabsByWorktree: {
      [WORKTREE_ID]: [
        makeUnifiedTab({
          id: 'tab-local',
          worktreeId: WORKTREE_ID,
          groupId: 'group-1',
          executionHostId: 'local'
        }),
        makeUnifiedTab({
          id: 'tab-remote',
          worktreeId: WORKTREE_ID,
          groupId: 'group-1',
          executionHostId: REMOTE_HOST
        }),
        makeUnifiedTab({
          id: localFileId,
          worktreeId: WORKTREE_ID,
          groupId: 'group-1',
          contentType: 'editor',
          executionHostId: 'local'
        }),
        makeUnifiedTab({
          id: remoteFileId,
          worktreeId: WORKTREE_ID,
          groupId: 'group-1',
          contentType: 'editor',
          executionHostId: REMOTE_HOST
        })
      ]
    },
    groupsByWorktree: {
      [WORKTREE_ID]: [
        makeTabGroup({
          id: 'group-1',
          worktreeId: WORKTREE_ID,
          activeTabId: 'tab-local',
          tabOrder: ['tab-local', 'tab-remote', localFileId, remoteFileId]
        })
      ]
    },
    openFiles: [
      makeOpenFile({ id: localFileId, worktreeId: WORKTREE_ID, isDirty: true }),
      makeOpenFile({
        id: remoteFileId,
        filePath: '/work/same/remote.ts',
        worktreeId: WORKTREE_ID,
        runtimeEnvironmentId: 'env-b',
        isDirty: true
      })
    ],
    editorDrafts: { [localFileId]: 'unsaved local edit', [remoteFileId]: 'unsaved remote edit' },
    recentlyClosedEditorTabsByWorktree: {
      [WORKTREE_ID]: [
        { ...closedSnapshot('/work/same/old-remote.ts'), runtimeEnvironmentId: 'env-b' },
        closedSnapshot('/work/same/old-local.ts')
      ]
    },
    recentlyClosedTabKindsByWorktree: { [WORKTREE_ID]: ['editor', 'browser', 'editor'] }
  })
  return store
}

describe('removing a remote project keeps its local twin', () => {
  it('keeps the local shell, tab, dirty document and draft', async () => {
    const store = seedTwins()
    updateNativeChatComposerDraft('tab-local:leaf-1', { text: 'local chat draft' }, 'deferred')

    await store.getState().removeProject(PROJECT_ID, { hostId: REMOTE_HOST })

    const state = store.getState()
    expect(state.repos).toEqual([localRow])
    expect(ptyKill).not.toHaveBeenCalledWith('pty-local')
    expect(state.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual(['tab-local'])
    expect(state.ptyIdsByTabId['tab-local']).toEqual(['pty-local'])
    expect(state.unifiedTabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'tab-local',
      '/work/same/local.ts'
    ])
    expect(state.openFiles.map((file) => file.id)).toEqual(['/work/same/local.ts'])
    expect(state.editorDrafts).toEqual({ '/work/same/local.ts': 'unsaved local edit' })
    expect(readNativeChatComposerDraft('tab-local:leaf-1').text).toBe('local chat draft')
    // The survivor's reopen stack must not offer the removed host's files, then or before.
    expect(
      state.recentlyClosedEditorTabsByWorktree[WORKTREE_ID]?.map((snapshot) => snapshot.filePath)
    ).toEqual(['/work/same/old-local.ts'])
    expect(state.recentlyClosedTabKindsByWorktree[WORKTREE_ID]).toEqual(['browser', 'editor'])
  })

  it('closes the removed host’s browsers, chats and hydrated terminals, and tabs opened meanwhile', async () => {
    const store = seedTwins()
    const unified = (overrides: Partial<Tab> & { id: string }): Tab =>
      makeUnifiedTab({ worktreeId: WORKTREE_ID, groupId: 'group-1', ...overrides })
    const closedBrowser = (id: string, browserRuntimeEnvironmentId: string | null) => ({
      workspace: browserWorkspace(id),
      pages: [{ ...browserWorkspace(id), workspaceId: id, browserRuntimeEnvironmentId }]
    })
    store.setState((s) => ({
      recentlyClosedBrowserTabsByWorktree: {
        [WORKTREE_ID]: [
          closedBrowser('closed-remote', 'env-b'),
          closedBrowser('closed-local', null)
        ]
      },
      recentlyClosedTabKindsByWorktree: { [WORKTREE_ID]: ['browser', 'browser'] },
      browserTabsByWorktree: {
        [WORKTREE_ID]: [
          browserWorkspace('browser-local'),
          browserWorkspace('browser-remote'),
          browserWorkspace('browser-remote-unstamped')
        ]
      },
      browserPagesByWorkspace: {
        'browser-remote-unstamped': closedBrowser('browser-remote-unstamped', 'env-b').pages
      },
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [
          ...(s.unifiedTabsByWorktree[WORKTREE_ID] ?? []),
          unified({ id: 'browser-local', contentType: 'browser', executionHostId: 'local' }),
          unified({ id: 'browser-remote', contentType: 'browser', executionHostId: REMOTE_HOST }),
          unified({ id: 'browser-remote-unstamped', contentType: 'browser' }),
          unified({
            id: 'chat-remote',
            contentType: 'agent-session',
            executionHostId: REMOTE_HOST
          }),
          unified({ id: 'hydrated-remote', executionHostId: REMOTE_HOST }),
          unified({ id: 'sim-remote', contentType: 'simulator', executionHostId: REMOTE_HOST })
        ]
      }
    }))
    // Opened while the host call was pending, so the pre-call snapshot cannot see it.
    onRepoRemoved = () =>
      store.setState((s) => ({
        unifiedTabsByWorktree: {
          [WORKTREE_ID]: [
            ...(s.unifiedTabsByWorktree[WORKTREE_ID] ?? []),
            unified({ id: 'late-remote', executionHostId: REMOTE_HOST })
          ]
        }
      }))

    await store.getState().removeProject(PROJECT_ID, { hostId: REMOTE_HOST })

    const state = store.getState()
    expect(state.browserTabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'browser-local'
    ])
    expect(state.unifiedTabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'tab-local',
      '/work/same/local.ts',
      'browser-local'
    ])
    expect(
      state.recentlyClosedBrowserTabsByWorktree[WORKTREE_ID]?.map((entry) => entry.workspace.id)
    ).toEqual(['closed-local'])
    expect(state.recentlyClosedTabKindsByWorktree[WORKTREE_ID]).toEqual(['browser'])
  })

  it('attributes unstamped terminals by the host their PTY ids name, wherever those are kept', async () => {
    const store = createTestStore()
    const sshRow: Repo = { ...localRow, connectionId: 'target-1', executionHostId: 'ssh:target-1' }
    const sshPtyId = toAppSshPtyId('target-1', 'relay-1')
    store.setState({
      repos: [localRow, sshRow, remoteRow],
      worktreesByRepo: {
        [PROJECT_ID]: [
          makeWorktree({ id: WORKTREE_ID, repoId: PROJECT_ID, hostId: 'local' }),
          makeWorktree({ id: WORKTREE_ID, repoId: PROJECT_ID, hostId: 'ssh:target-1' })
        ]
      },
      tabsByWorktree: {
        [WORKTREE_ID]: [
          makeTab({ id: 'tab-local', worktreeId: WORKTREE_ID, ptyId: 'pty-local' }),
          makeTab({ id: 'tab-ssh', worktreeId: WORKTREE_ID, ptyId: sshPtyId }),
          // Restored: the only record of its host is the layout's pane binding.
          makeTab({ id: 'tab-ssh-restored', worktreeId: WORKTREE_ID })
        ]
      },
      ptyIdsByTabId: { 'tab-local': ['pty-local'], 'tab-ssh': [sshPtyId] },
      terminalLayoutsByTabId: {
        'tab-ssh-restored': {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-1': toAppSshPtyId('target-1', 'relay-2') }
        }
      }
    })

    await store.getState().removeProject(PROJECT_ID, { hostId: 'ssh:target-1' })

    expect(ptyKill).not.toHaveBeenCalledWith('pty-local')
    expect(ptyKill).toHaveBeenCalledWith(sshPtyId)
    expect(ptyKill).toHaveBeenCalledWith(toAppSshPtyId('target-1', 'relay-2'))
    expect(store.getState().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'tab-local'
    ])
  })

  it('purges the shared state when both copies are removed at once', async () => {
    const store = seedTwins()

    await Promise.all([
      store.getState().removeProject(PROJECT_ID, { hostId: REMOTE_HOST }),
      store.getState().removeProject(PROJECT_ID, { hostId: 'local' })
    ])

    const state = store.getState()
    expect(state.repos).toEqual([])
    expect(state.tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
    expect(state.unifiedTabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
    expect(state.openFiles).toEqual([])
  })

  it('keeps a PTY that a tab outside the removal still binds', async () => {
    const store = createTestStore()
    const sshRow: Repo = { ...localRow, connectionId: 'target-1', executionHostId: 'ssh:target-1' }
    const sharedPtyId = toAppSshPtyId('target-1', 'relay-shared')
    const otherWorktreeId = 'other-repo::/work/other'
    store.setState({
      repos: [localRow, sshRow],
      worktreesByRepo: {
        [PROJECT_ID]: [
          makeWorktree({ id: WORKTREE_ID, repoId: PROJECT_ID, hostId: 'local' }),
          makeWorktree({ id: WORKTREE_ID, repoId: PROJECT_ID, hostId: 'ssh:target-1' })
        ]
      },
      tabsByWorktree: {
        [WORKTREE_ID]: [makeTab({ id: 'tab-ssh', worktreeId: WORKTREE_ID, ptyId: sharedPtyId })],
        [otherWorktreeId]: [
          makeTab({ id: 'tab-other', worktreeId: otherWorktreeId, ptyId: sharedPtyId })
        ]
      },
      ptyIdsByTabId: { 'tab-ssh': [sharedPtyId], 'tab-other': [sharedPtyId] }
    })

    await store.getState().removeProject(PROJECT_ID, { hostId: 'ssh:target-1' })

    expect(ptyKill).not.toHaveBeenCalledWith(sharedPtyId)
    expect(store.getState().tabsByWorktree[otherWorktreeId]?.map((tab) => tab.id)).toEqual([
      'tab-other'
    ])
  })
})
