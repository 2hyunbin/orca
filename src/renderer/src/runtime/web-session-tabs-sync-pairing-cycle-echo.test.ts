import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { takeEchoesNoLongerFenced } from './web-session-tabs-sync/mirrored-snapshot-host-fence'
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

function applyServerReadme(state: MirrorState, worktree: string, version = 1): MirrorState {
  const snapshot = makeSnapshot([README], {
    worktree,
    snapshotVersion: version,
    activeTabId: 'server-readme',
    activeTabType: 'markdown'
  })
  return { ...state, ...applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW + version) }
}

function serverReadmeIn(state: MirrorState, worktree: string): boolean {
  return (
    (state.unifiedTabsByWorktree[worktree] ?? []).some((tab) => tab.id === 'server-readme') ||
    state.openFiles.some((file) => file.worktreeId === worktree)
  )
}

const OTHER_HOSTS: [string, ExecutionHostId[]][] = [
  ['the server’s workspace', ['runtime:other-server']],
  ['a workspace both hosts list', ['local', `runtime:${ENV}`]]
]

describe('a paired server echoing this app’s workspace back', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it.each([WT, FOLDER])('keeps the echo out of this app’s own workspace %s', (worktree) => {
    expect(serverReadmeIn(applyServerReadme(stateListing(['local']), worktree), worktree)).toBe(
      false
    )
  })

  it('retires an echo it took before this app’s own row listed', () => {
    const cold = applyServerReadme(stateListing([]), WT)
    expect(serverReadmeIn(cold, WT)).toBe(true)
    const listed = { ...cold, worktreesByRepo: stateListing(['local']).worktreesByRepo }
    expect(serverReadmeIn(applyServerReadme(listed, WT, 2), WT)).toBe(false)
  })

  it('releases a held frame once the server lists its own copy', () => {
    applyServerReadme(stateListing(['local']), WT)
    expect(takeEchoesNoLongerFenced(stateListing(['local']))).toEqual([])
    expect(takeEchoesNoLongerFenced(stateListing(['local', `runtime:${ENV}`]))).toEqual([
      { environmentId: ENV, workspaceId: WT }
    ])
  })

  it.each(OTHER_HOSTS)('still mirrors the server’s tabs in %s', (_label, hostIds) => {
    expect(serverReadmeIn(applyServerReadme(stateListing(hostIds), WT), WT)).toBe(true)
  })
})
