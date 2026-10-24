import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  moveWebRuntimeLeafToNewTab,
  resolvePaneMoveHost,
  revertRefusedPaneMove
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
const refresh = vi.hoisted(() => vi.fn())
vi.mock('../store', () => ({ useAppStore: { getState: () => store.state } }))
vi.mock('./runtime-rpc-client', () => ({ runtimeEnvironmentSupportsCapability: supports }))
vi.mock('./web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: refresh
}))
const REQUEST = {
  worktreeId: WORKTREE_ID,
  sourceTabId: toWebTerminalSurfaceTabId('host-source'),
  targetTabId: toWebTerminalSurfaceTabId('host-target'),
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: 'remote:web-env-1@@term-1'
}
const PLACEMENT = { targetGroupId: 'host-group', index: 0 }
describe('moveWebRuntimeLeafToNewTab', () => {
  beforeEach(() => {
    supports.mockReset()
    refresh.mockReset()
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
  it('asks the host to move the pane by host tab ids, placed where it was dropped', async () => {
    const call = vi.fn().mockResolvedValue({
      id: 'm',
      ok: true,
      result: { status: 'moved', ptyId: 'host-pty-1' }
    })
    stubRuntimeEnvironmentBridge({ call })
    await expect(moveWebRuntimeLeafToNewTab(ENVIRONMENT_ID, REQUEST, PLACEMENT)).resolves.toBe(true)
    expect(call.mock.calls[0][0]).toMatchObject({
      method: 'session.tabs.movePaneToNewTab',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        sourceTabId: 'host-source',
        targetTabId: 'host-target',
        leafId: '11111111-1111-4111-8111-111111111111',
        targetGroupId: 'host-group',
        index: 0
      }
    })
  })
  it('reports no move when the host refuses it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const call = vi.fn().mockResolvedValue({
      id: 'm',
      ok: true,
      result: { status: 'not_held' }
    })
    stubRuntimeEnvironmentBridge({ call })
    await expect(moveWebRuntimeLeafToNewTab(ENVIRONMENT_ID, REQUEST, PLACEMENT)).resolves.toBe(
      false
    )
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
  it('reverts a refused move without stopping its terminal and redraws even an unchanged list', async () => {
    const order: string[] = []
    const closeTab = vi.fn(() => order.push('close'))
    const transferAgentPaneAuthority = vi.fn(() => order.push('transfer'))
    store.state = { ...store.state, closeTab, transferAgentPaneAuthority }
    await revertRefusedPaneMove(ENVIRONMENT_ID, REQUEST)
    // The pane's status and launch records return to the source before the drawn tab goes.
    expect(transferAgentPaneAuthority).toHaveBeenCalledWith({
      fromPaneKey: `${REQUEST.targetTabId}:${REQUEST.leafId}`,
      toPaneKey: `${REQUEST.sourceTabId}:${REQUEST.leafId}`,
      ptyId: REQUEST.ptyId
    })
    expect(order).toEqual(['transfer', 'close'])
    expect(closeTab).toHaveBeenCalledWith(
      REQUEST.targetTabId,
      expect.objectContaining({
        remoteCloseOwnedByHost: true,
        localPtyTeardownOwnedExternally: true
      })
    )
    expect(refresh).toHaveBeenCalledWith(ENVIRONMENT_ID, WORKTREE_ID, {
      acceptCurrentSnapshot: true
    })
  })
})
