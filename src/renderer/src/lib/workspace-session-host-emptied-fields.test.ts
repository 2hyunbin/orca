import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import {
  patchWorkspaceSessionByHost,
  type HostPersistenceState
} from './workspace-session-host-persistence'

const RUNTIME = 'runtime:env-1' as ExecutionHostId
const WT = 'repo-remote::/srv/project'

// #23914: main merges a patch fieldwise, so a runtime partition the patch omits keeps a closed tab.
async function patchAfterLastBrowserTabCloses(
  state: Partial<HostPersistenceState>
): Promise<Record<string, Partial<WorkspaceSessionState>>> {
  const partitions: Record<string, Partial<WorkspaceSessionState>> = {
    local: { browserTabsByWorktree: {}, browserPagesByWorkspace: {} },
    [RUNTIME]: {
      browserTabsByWorktree: { [WT]: [{ id: 'bw-1', worktreeId: WT } as never] },
      browserPagesByWorkspace: { 'bw-1': [{ id: 'p-1', workspaceId: 'bw-1' } as never] }
    }
  }
  await patchWorkspaceSessionByHost(
    {
      get: async () => ({}) as WorkspaceSessionState,
      patch: async (patch: WorkspaceSessionPatch, hostId?: ExecutionHostId) => {
        const key = hostId ?? 'local'
        partitions[key] = { ...partitions[key], ...patch }
      }
    },
    { browserTabsByWorktree: {}, browserPagesByWorkspace: {} },
    {
      repos: [{ id: 'repo-remote', connectionId: null, executionHostId: RUNTIME }],
      worktreesByRepo: {},
      tabsByWorktree: {},
      ...state
    }
  ).written
  return partitions
}

describe('a patch that empties a field on a runtime host', () => {
  it('clears the closed tab from a runtime partition this window loaded', async () => {
    const partitions = await patchAfterLastBrowserTabCloses({
      hydratedRuntimeSessionHostIds: [RUNTIME]
    })
    expect(partitions[RUNTIME]?.browserTabsByWorktree).toEqual({})
    expect(partitions[RUNTIME]?.browserPagesByWorkspace).toEqual({})
  })

  it('leaves a runtime partition this window never loaded', async () => {
    const partitions = await patchAfterLastBrowserTabCloses({})
    expect(partitions[RUNTIME]?.browserTabsByWorktree?.[WT]).toHaveLength(1)
  })
})
