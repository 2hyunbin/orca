/**
 * Deletion fence: a removed worktree's rows must not reappear for a same-id
 * recreation. The Store purges the removed owner's session (and fences late
 * window writes by topology revision); the phone list projects that session.
 */
import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'

const WT = 'repo-1::/tmp/worktree-a'
const LEAF = '11111111-1111-4111-8111-111111111111'

function sessionWithOldOccupantTab(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WT]: [
        {
          id: 'tab-1',
          ptyId: null,
          worktreeId: WT,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      'tab-1': { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
    }
  }
}

describe('graph-sync deletion fence', () => {
  it("does not show the deleted occupant's rows after same-id recreation", () => {
    let meta: { instanceId: string } | undefined = { instanceId: 'old-instance' }
    let session = sessionWithOldOccupantTab()
    const store = {
      getRepo: () => ({
        id: 'repo-1',
        path: '/tmp/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1
      }),
      getRepos: () => [store.getRepo()],
      getAllWorktreeMeta: () => ({}),
      getGitHubCache: () => ({ pr: {}, issue: {} }),
      getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
      getWorktreeMeta: () => meta,
      // As the real Store's removeWorktreeMeta: the owner's session rows go with its metadata.
      removeWorktreeMeta: () => {
        meta = undefined
        const { [WT]: _removed, ...tabsByWorktree } = session.tabsByWorktree
        session = { ...session, tabsByWorktree, terminalLayoutsByTabId: {} }
      },
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      }
    }
    const runtime = new OrcaRuntimeService(store as never)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test reaches protected runtime members that exist on OrcaRuntimeService.
    const internals = runtime as unknown as {
      removeWorktreeMetadataAndHistory: (store: unknown, worktreeId: string) => void
      getMobileSessionTabsForWorktree: (worktreeId: string) => RuntimeMobileSessionTabsResult
    }
    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
    expect(internals.getMobileSessionTabsForWorktree(WT).tabs).toHaveLength(1)

    internals.removeWorktreeMetadataAndHistory(store, WT)
    expect(events).toEqual([expect.objectContaining({ worktree: WT, removed: true })])
    meta = { instanceId: 'new-instance' }

    expect(internals.getMobileSessionTabsForWorktree(WT).tabs).toEqual([])
  })
})
