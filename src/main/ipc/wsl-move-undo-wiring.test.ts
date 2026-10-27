import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { wslMoveCutoverFixture } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { wslMoverProfile } from '../persistence/__fixtures__/wsl-mover/wsl-mover-profiles'
import { createWslMoveUndoPorts } from './wsl-move-undo-wiring'

vi.mock('./runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: vi.fn()
}))
const host = vi.hoisted(() => ({ disabled: new Array<string[]>(), listed: true }))
vi.mock('../../shared/runtime-environment-store', () => ({
  listEnvironments: () => (host.listed ? [{ id: 'wsl:Ubuntu' }] : [])
}))
vi.mock('./wsl-host-automation-disable', () => ({
  disableWslHostAutomations: async (_userData: string, _environmentId: string, ids: string[]) => {
    host.disabled.push([...ids])
    return [...ids]
  },
  restoreWslHostAutomations: async () => {}
}))

const MOVED = wslMoverProfile('mixed-windows-wsl', 'source').session.activeWorktreeId ?? ''
const MOVED_ON_HOST = 'repo-a::/home/dev/app'

// verify-15b 6c: after undo the window reopened the host copy it was focused on, and the host
// resumed the pane's agent there beside the one restored here.
describe("undo's return of focus", () => {
  it('points the local session back at the project here before the window reloads', () => {
    const move = wslMoveCutoverFixture(
      'move-1',
      'retained',
      {},
      { repoIds: ['repo-a'], folderWorkspaceIds: [] }
    )
    let session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [MOVED]: [] },
      activeWorktreeId: MOVED_ON_HOST,
      activeWorkspaceKey: `worktree:${MOVED_ON_HOST}`,
      activeWorkspaceExecutionHostId: toRuntimeExecutionHostId(move.destinationEnvironmentId)
    }
    const store = {
      getWorkspaceSession: () => session,
      listAutomations: () => [],
      patchWorkspaceSession: vi.fn((patch: Partial<WorkspaceSessionState>, hostId?: string) => {
        expect(hostId).toBe(LOCAL_EXECUTION_HOST_ID)
        session = { ...session, ...patch }
      })
    }
    createWslMoveUndoPorts(store, '/user-data').refocusHere?.(move)
    expect(session).toMatchObject({
      activeWorkspaceExecutionHostId: LOCAL_EXECUTION_HOST_ID,
      activeWorktreeId: MOVED,
      activeWorkspaceKey: `worktree:${MOVED}`
    })
    // A second call finds focus already here and writes nothing.
    store.patchWorkspaceSession.mockClear()
    createWslMoveUndoPorts(store, '/user-data').refocusHere?.(move)
    expect(store.patchWorkspaceSession).not.toHaveBeenCalled()
  })
})

describe("undo's host automation port", () => {
  const move = wslMoveCutoverFixture(
    'move-1',
    'retained',
    {},
    { repoIds: ['repo-a'] },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the port reads only the moved automations' ids.
    { automations: [{ id: 'moved-on' }, { id: 'moved-off' }] } as never
  )
  const store = {
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    patchWorkspaceSession: vi.fn(),
    listAutomations: () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the port reads only `id` and `enabled`.
      [
        { id: 'moved-on', enabled: true },
        { id: 'moved-off', enabled: false },
        { id: 'not-moved', enabled: true }
      ] as never
  }

  it("turns off the host's copies of this move's automations that are on here", async () => {
    host.disabled = []
    host.listed = true
    expect(
      (await createWslMoveUndoPorts(store, '/user-data').stopHostAutomations?.(move))?.outcome
    ).toBe('stopped')
    expect(host.disabled).toEqual([['moved-on']])
  })

  it('asks a removed host nothing', async () => {
    host.disabled = []
    host.listed = false
    expect(
      (await createWslMoveUndoPorts(store, '/user-data').stopHostAutomations?.(move))?.outcome
    ).toBe('stopped')
    expect(host.disabled).toEqual([])
  })
})
