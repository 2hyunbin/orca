import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
import type { WorktreeOperationRouteState } from '../lib/worktree-operation-route'
import {
  ENV,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

// #33424: this app pairs to server ENV while ENV pairs back to this app. ENV mirrors this app's own
// workspace WT and publishes that mirror under WT's real id.
const README: RuntimeMobileSessionTabsResult['tabs'][number] = {
  type: 'markdown',
  id: 'server-readme',
  title: 'README.md',
  filePath: '/repo/README.md',
  relativePath: 'README.md',
  language: 'markdown',
  mode: 'edit',
  isDirty: false,
  isActive: true,
  sourceFileId: '/repo/README.md',
  sourceFilePath: '/repo/README.md',
  sourceRelativePath: 'README.md',
  documentVersion: 'file:/repo/README.md',
  color: null,
  isPinned: false
}

type MirrorState = WebSessionTabsSyncState & WorktreeOperationRouteState

const FOLDER = 'folder:fw'

function stateListing(hostIds: ExecutionHostId[]): MirrorState {
  return {
    ...makeState({ activeWorktreeId: null }),
    repos: [{ id: 'repo', connectionId: null }],
    worktreesByRepo: { repo: hostIds.map((hostId) => ({ id: WT, repoId: 'repo', hostId })) },
    folderWorkspaces: hostIds.map((executionHostId) => ({
      id: 'fw',
      projectGroupId: 'group',
      executionHostId
    })),
    runtimeEnvironments: [{ id: ENV }],
    runtimeEnvironmentCatalogHydrated: true
  }
}

function applyServerReadme(state: MirrorState, worktree: string): MirrorState {
  const snapshot = makeSnapshot([README], {
    worktree,
    activeTabId: 'server-readme',
    activeTabType: 'markdown'
  })
  return { ...state, ...applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW) }
}

const OTHER_HOSTS: [string, ExecutionHostId[]][] = [
  ['the server’s workspace', ['runtime:other-server']],
  ['a workspace both hosts list', ['local', `runtime:${ENV}`]]
]

describe('a paired server echoing this app’s workspace back', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it.each([WT, FOLDER])('keeps the echo out of this app’s own workspace %s', (worktree) => {
    const state = stateListing(['local'])
    expect(applyServerReadme(state, worktree).unifiedTabsByWorktree).toBe(
      state.unifiedTabsByWorktree
    )
  })

  it.each(OTHER_HOSTS)('still mirrors the server’s tabs in %s', (_label, hostIds) => {
    const next = applyServerReadme(stateListing(hostIds), WT)
    expect(next.unifiedTabsByWorktree[WT]?.map((tab) => tab.id)).toContain('server-readme')
  })
})
