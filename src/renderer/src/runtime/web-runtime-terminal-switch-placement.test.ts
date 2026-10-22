// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { createWebRuntimeSessionTerminalResult } from './web-runtime-terminal-create-operation'
import { refreshWebRuntimeSessionTabsSnapshot } from './web-runtime-session-snapshot'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'

const ENV = 'paired-placement',
  WT = 'repo::/repo'
const chat = (id: string) => ({
  type: 'agent-session' as const,
  id: `agent-session:${id}`,
  sessionId: id,
  agent: 'codex' as const,
  title: id,
  isActive: false
})
let frame: RuntimeMobileSessionTabsResult
beforeEach(() => {
  resetWebSessionTabsSnapshotFreshnessForTests()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeWorktreeId: WT,
    activeWorkspaceExecutionHostId: `runtime:${ENV}`,
    settings: { ...useAppStore.getState().settings, activeRuntimeEnvironmentId: ENV }
  })
  frame = {
    worktree: WT,
    publicationEpoch: 'host-placement',
    snapshotVersion: 1,
    activeGroupId: 'R',
    activeTabId: 'agent-session:D',
    activeTabType: 'agent-session',
    tabs: ['A', 'C', 'B', 'D'].map(chat),
    tabGroups: [
      {
        id: 'L',
        activeTabId: 'agent-session:C',
        tabOrder: ['A', 'C', 'B'].map((id) => `agent-session:${id}`)
      },
      { id: 'R', activeTabId: 'agent-session:D', tabOrder: ['agent-session:D'] }
    ]
  }
  useAppStore.setState((state) => applyWebSessionTabsSnapshot(state, frame, ENV))
})
it.each([false, true])(
  'keeps client neighbors and pin partitions through early retirement and refresh (pinned: %s)',
  async (pinned) => {
    if (pinned) {
      frame = {
        ...frame,
        snapshotVersion: frame.snapshotVersion + 1,
        tabs: [
          ...frame.tabs.map((tab) => ({
            ...tab,
            isPinned: ['agent-session:A', 'agent-session:C', 'agent-session:B'].includes(tab.id)
          })),
          chat('U')
        ],
        tabGroups: frame.tabGroups?.map((group) =>
          group.id === 'L' ? { ...group, tabOrder: [...group.tabOrder, 'agent-session:U'] } : group
        )
      }
      useAppStore.setState((state) => applyWebSessionTabsSnapshot(state, frame, ENV))
    }
    const before = useAppStore.getState()
    const source = before.unifiedTabsByWorktree[WT].find((tab) => tab.entityId === 'C')!
    const sourceGroup = source.groupId
    const runtimeCall = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'session.tabs.createTerminal') {
        frame = {
          ...frame,
          snapshotVersion: frame.snapshotVersion + 1,
          tabs: [
            ...frame.tabs.filter((tab) => tab.id !== 'agent-session:C'),
            {
              type: 'terminal',
              id: 'T::leaf',
              parentTabId: 'T',
              leafId: 'leaf',
              title: 'Terminal',
              terminal: 'term_T',
              isActive: false,
              status: 'ready'
            }
          ],
          tabGroups: [
            {
              id: 'L',
              activeTabId: 'T',
              tabOrder: [
                'agent-session:A',
                'agent-session:B',
                'T',
                ...(pinned ? ['agent-session:U'] : [])
              ]
            },
            frame.tabGroups![1]
          ]
        }
        // Publication beats the create response, with C already gone and T at the host's old fallback.
        useAppStore.setState((state) => applyWebSessionTabsSnapshot(state, frame, ENV))
        expect(
          useAppStore.getState().unifiedTabsByWorktree[WT].some((tab) => tab.entityId === 'C')
        ).toBe(false)
        useAppStore.getState().createUnifiedTab(WT, 'editor', {
          id: 'concurrent',
          entityId: '/repo/concurrent',
          targetGroupId: sourceGroup
        })
        return { id: 'create', ok: true as const, result: { tab: frame.tabs.at(-1) } }
      }
      if (method === 'session.tabs.list') {
        return { id: 'list', ok: true as const, result: frame }
      }
      throw new Error(`Unexpected ${method}`)
    })
    Object.assign(window, {
      api: {
        ...window.api,
        runtimeEnvironments: { ...window.api?.runtimeEnvironments, call: runtimeCall }
      }
    })
    const result = await createWebRuntimeSessionTerminalResult({
      environmentId: ENV,
      worktreeId: WT,
      afterTabId: source.id,
      targetGroupId: sourceGroup,
      launchAgent: 'codex',
      command: 'codex resume conversation',
      resumeOrigin: 'switch',
      providerSession: { key: 'session_id', id: 'conversation' },
      selectWorktree: false,
      activate: true
    })
    expect(result.outcome.status).toBe('created')
    const order = () =>
      useAppStore.getState().groupsByWorktree[WT].find((group) => group.id === sourceGroup)!
        .tabOrder
    expect(order()).toEqual([
      'structured-agent-session-A',
      ...(pinned ? ['structured-agent-session-B'] : []),
      toWebTerminalSurfaceTabId('T'),
      ...(pinned ? ['structured-agent-session-U'] : ['structured-agent-session-B']),
      'concurrent'
    ])
    expect(useAppStore.getState().activeGroupIdByWorktree[WT]).toBe(sourceGroup)
    await refreshWebRuntimeSessionTabsSnapshot(ENV, WT, { acceptCurrentSnapshot: true })
    expect(order()).toEqual([
      'structured-agent-session-A',
      ...(pinned ? ['structured-agent-session-B'] : []),
      toWebTerminalSurfaceTabId('T'),
      ...(pinned ? ['structured-agent-session-U'] : ['structured-agent-session-B']),
      'concurrent'
    ])
  }
)
