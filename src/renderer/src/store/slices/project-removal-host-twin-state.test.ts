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

function answerLikeRuntimeHost(args: RuntimeEnvironmentCallRequest): unknown {
  const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
  if (compatible) {
    return compatible
  }
  return { id: args.method, ok: true, result: {}, _meta: { runtimeId: 'runtime-remote' } }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  ptyKill.mockReset()
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
    editorDrafts: { [localFileId]: 'unsaved local edit', [remoteFileId]: 'unsaved remote edit' }
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
  })
})
