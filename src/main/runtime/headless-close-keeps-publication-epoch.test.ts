import { describe, expect, it, vi } from 'vitest'
import type { DurableProfileStateMutation } from '../persistence/loading-store/store-runtime-state'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/**
 * Closing a tab is not a handover to a new publisher: a paired client retires the epoch it
 * displaces, and the web mirror's retirement is final, so a close that changed the epoch would
 * make every later frame for the worktree rejected forever.
 */
const WORKTREE_ID = 'repo-1::/tmp/headless-close'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function terminalRow(id: string, sortOrder: number) {
  return {
    id,
    ptyId: null,
    worktreeId: WORKTREE_ID,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: 1
  }
}

function makeStore() {
  let session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [terminalRow('tab-a', 0), terminalRow('tab-b', 1)]
    },
    terminalLayoutsByTabId: {
      'tab-a': {
        root: { type: 'leaf', leafId: LEAF_A },
        activeLeafId: LEAF_A,
        expandedLeafId: null
      },
      'tab-b': {
        root: { type: 'leaf', leafId: LEAF_B },
        activeLeafId: LEAF_B,
        expandedLeafId: null
      }
    }
  }
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn((next: WorkspaceSessionState) => {
      session = next
    }),
    runDurableMutation: async <T>(mutate: () => DurableProfileStateMutation<T>) => mutate().value,
    getRepos: vi.fn(() => [
      {
        id: 'repo-1',
        path: '/tmp/headless-close',
        displayName: 'headless',
        badgeColor: '#000000',
        addedAt: 0
      }
    ]),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

describe('closing a headless mobile terminal tab', () => {
  it('keeps the epoch and advances the version so clients accept the frame', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeStore covers the reads this suite drives.
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const selector = `id:${WORKTREE_ID}`
    const before = await runtime.listMobileSessionTabs(selector)
    expect(before.tabs.map((tab) => tab.id)).toEqual([`tab-a::${LEAF_A}`, `tab-b::${LEAF_B}`])

    await runtime.closeMobileSessionTab(selector, `tab-a::${LEAF_A}`)

    const after = await runtime.listMobileSessionTabs(selector)
    expect(after.publicationEpoch).toBe(before.publicationEpoch)
    expect(after.snapshotVersion).toBeGreaterThan(before.snapshotVersion)
    expect(after.tabs.map((tab) => tab.id)).toEqual([`tab-b::${LEAF_B}`])
  })
})
