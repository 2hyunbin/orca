import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'

const WT = 'repo::/srv/project'
const ENV = 'env-1'
const T1 = toWebTerminalSurfaceTabId('host-tab-1')
const T2 = toWebTerminalSurfaceTabId('host-tab-2')

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown>, call: vi.fn() }))
vi.mock('../store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('./web-session-tabs-sync/frame-drawn-server-workspaces', () => ({
  isServerFrameDrawnWorkspace: () => false
}))

import {
  reportVisibleTabPickToHost,
  resetReportedVisibleTabPicksForTests
} from './web-session-visible-tab-pick-report'

function surface(hostTabId: string, status: 'ready' | 'pending-handle' = 'ready', leafId = 'leaf') {
  return {
    type: 'terminal' as const,
    id: `${hostTabId}::${leafId}`,
    title: hostTabId,
    parentTabId: hostTabId,
    leafId,
    isActive: false,
    ...(status === 'ready'
      ? { status: 'ready' as const, terminal: `term-${hostTabId}` }
      : { status: 'pending-handle' as const, terminal: null })
  }
}

function frame(
  pickedHostTabId: string,
  overrides: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'epoch-1:client-navigation',
    snapshotVersion: 1,
    activeGroupId: 'host-group',
    activeTabId: `${pickedHostTabId}::leaf`,
    activeTabType: 'terminal',
    tabs: [surface('host-tab-1'), surface('host-tab-2')],
    ...overrides
  }
}

describe('reporting the tab the desktop shows to a server that remembers picks per device', () => {
  beforeEach(() => {
    resetReportedVisibleTabPicksForTests()
    mocks.call.mockReset().mockResolvedValue({ ok: true, result: {} })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: mocks.call } } })
    mocks.state = {
      activeGroupIdByWorktree: { [WT]: 'group' },
      groupsByWorktree: { [WT]: [{ id: 'group', activeTabId: 'u1', tabOrder: ['u1', 'u2'] }] },
      unifiedTabsByWorktree: {
        [WT]: [
          { id: 'u1', contentType: 'terminal', entityId: T1 },
          { id: 'u2', contentType: 'terminal', entityId: T2 }
        ]
      },
      terminalLayoutsByTabId: { [T1]: { activeLeafId: 'leaf' } }
    }
  })

  it('moves a stale server pick back to the visible tab, once', () => {
    reportVisibleTabPickToHost(ENV, frame('host-tab-2'))
    reportVisibleTabPickToHost(ENV, frame('host-tab-2'))

    expect(mocks.call).toHaveBeenCalledTimes(1)
    expect(mocks.call.mock.calls[0]?.[0]).toMatchObject({
      selector: ENV,
      method: 'session.tabs.activate',
      params: {
        tabId: 'host-tab-1',
        leafId: 'leaf',
        notifyClients: false,
        navigation: 'caller',
        intent: 'automatic'
      }
    })
  })

  it('retries after the server answers with an error', async () => {
    mocks.call.mockResolvedValueOnce({ ok: false, error: { code: 'busy' } })
    reportVisibleTabPickToHost(ENV, frame('host-tab-2'))
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    reportVisibleTabPickToHost(ENV, frame('host-tab-2'))
    expect(mocks.call).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['the server already remembers it', frame('host-tab-1')],
    ['the server keeps no pick per device', frame('host-tab-2', { publicationEpoch: 'epoch-1' })],
    [
      'the visible tab has no ready terminal',
      frame('host-tab-2', {
        tabs: [surface('host-tab-1', 'pending-handle'), surface('host-tab-2')]
      })
    ],
    [
      'only a sibling of the visible pane is ready',
      frame('host-tab-2', {
        tabs: [
          surface('host-tab-1', 'ready', 'sibling'),
          surface('host-tab-1', 'pending-handle'),
          surface('host-tab-2')
        ]
      })
    ]
  ])('reports nothing when %s', (_case, snapshot) => {
    reportVisibleTabPickToHost(ENV, snapshot)
    expect(mocks.call).not.toHaveBeenCalled()
  })
})
