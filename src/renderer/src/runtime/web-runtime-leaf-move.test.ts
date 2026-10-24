import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  moveWebRuntimeLeafToNewTab,
  resolvePaneMoveHost,
  settleHostPaneMove
} from './web-runtime-leaf-move'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
const ENVIRONMENT_ID = 'web-env-1'
const WORKTREE_ID = 'repo::/worktree'
const store = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return { state }
})
const supports = vi.hoisted(() => vi.fn())
vi.mock('../store', () => ({ useAppStore: { getState: () => store.state } }))
vi.mock('./runtime-rpc-client', () => ({ runtimeEnvironmentSupportsCapability: supports }))
const followUps = vi.hoisted(() => ({ refresh: vi.fn(), reorder: vi.fn(), activate: vi.fn() }))
vi.mock('./web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: followUps.refresh
}))
vi.mock('./web-runtime-session-tab-move', () => ({ moveWebRuntimeSessionTab: followUps.reorder }))
vi.mock('./web-runtime-session-tab-lifecycle', () => ({
  activateWebRuntimeSessionTab: followUps.activate
}))
const REQUEST = {
  worktreeId: WORKTREE_ID,
  sourceTabId: toWebTerminalSurfaceTabId('host-source'),
  targetTabId: toWebTerminalSurfaceTabId('host-target'),
  leafId: 'leaf-a',
  ptyId: 'remote:web-env-1@@term-1'
}
describe('moveWebRuntimeLeafToNewTab', () => {
  beforeEach(() => {
    supports.mockReset()
    Object.values(followUps).forEach((mock) => mock.mockReset())
    store.state = {
      repos: [{ id: 'repo', executionHostId: `runtime:${ENVIRONMENT_ID}` }],
      worktreesByRepo: {
        repo: [
          {
            id: WORKTREE_ID,
            repoId: 'repo',
            hostId: `runtime:${ENVIRONMENT_ID}`,
            runtimeOwnerEnvironmentId: ENVIRONMENT_ID
          }
        ]
      }
    }
  })
  afterEach(() => vi.unstubAllGlobals())
  it('asks the host to move the pane by host tab ids', async () => {
    const call = vi.fn().mockResolvedValue({
      id: 'm',
      ok: true,
      result: { status: 'moved', ptyId: 'host-pty-1' }
    })
    stubRuntimeEnvironmentBridge({ call })
    await expect(moveWebRuntimeLeafToNewTab(ENVIRONMENT_ID, REQUEST)).resolves.toBe(true)
    expect(call.mock.calls[0][0]).toMatchObject({
      method: 'session.tabs.movePaneToNewTab',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        sourceTabId: 'host-source',
        targetTabId: 'host-target',
        leafId: 'leaf-a'
      }
    })
  })
  it('reports no move when the host refuses it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const call = vi.fn().mockResolvedValue({
      id: 'm',
      ok: false,
      error: { code: 'method_not_found', message: 'method_not_found' }
    })
    stubRuntimeEnvironmentBridge({ call })
    await expect(moveWebRuntimeLeafToNewTab(ENVIRONMENT_ID, REQUEST)).resolves.toBe(false)
  })
  it('names the host only when it advertises committing pane moves', async () => {
    stubRuntimeEnvironmentBridge({ call: vi.fn() })
    supports.mockResolvedValue(true)
    await expect(resolvePaneMoveHost(WORKTREE_ID)).resolves.toBe(ENVIRONMENT_ID)
    supports.mockResolvedValue(false)
    await expect(resolvePaneMoveHost(WORKTREE_ID)).resolves.toBeNull()
  })
  it('names no host for a worktree no runtime hosts', async () => {
    store.state = { repos: [], worktreesByRepo: {} }
    supports.mockResolvedValue(true)
    stubRuntimeEnvironmentBridge({ call: vi.fn() })
    await expect(resolvePaneMoveHost(WORKTREE_ID)).resolves.toBeNull()
    expect(supports).not.toHaveBeenCalled()
  })
  it('redraws the host tabs when the host did not move the pane', async () => {
    await settleHostPaneMove({
      environmentId: ENVIRONMENT_ID,
      request: REQUEST,
      moved: false,
      placedInGroupId: 'group-1'
    })
    expect(followUps.refresh).toHaveBeenCalledWith(ENVIRONMENT_ID, WORKTREE_ID)
    expect(followUps.reorder).not.toHaveBeenCalled()
    expect(followUps.activate).not.toHaveBeenCalled()
  })
  it('gives the host the drop position and focus of a committed move', async () => {
    const tabOrder = [REQUEST.targetTabId, REQUEST.sourceTabId]
    store.state = {
      ...store.state,
      groupsByWorktree: { [WORKTREE_ID]: [{ id: 'group-1', tabOrder }] },
      activeTabIdByWorktree: { [WORKTREE_ID]: REQUEST.targetTabId }
    }
    await settleHostPaneMove({
      environmentId: ENVIRONMENT_ID,
      request: REQUEST,
      moved: true,
      placedInGroupId: 'group-1'
    })
    expect(followUps.refresh).not.toHaveBeenCalled()
    expect(followUps.reorder).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'reorder',
        environmentId: ENVIRONMENT_ID,
        tabId: REQUEST.targetTabId,
        targetGroupId: 'group-1',
        tabOrder
      })
    )
    expect(followUps.activate).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: REQUEST.targetTabId, environmentId: ENVIRONMENT_ID })
    )
  })
})
