import type { ProcessTableRow } from '../../../../shared/process-table-snapshot'
import { useState } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import type { AppState } from '@/store/types'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type { PaneForegroundAgentEntry } from '../../store/slices/pane-foreground-agent'
import type { RemotePaneLayoutPusher } from './remote-pane-layout-push'
import { useAppStore } from '../../store'
import { useTerminalPaneChatState } from './use-terminal-pane-chat-state'
import { useTerminalPaneLayoutPersistence } from './use-terminal-pane-layout-persistence'
import { useTerminalPaneProjection } from './use-terminal-pane-projection'

export const LEFT = '11111111-1111-4111-8111-111111111111'
export const RIGHT = '22222222-2222-4222-8222-222222222222'
type ViewMode = NonNullable<Tab['viewMode']>
const mocks = vi.hoisted(() => {
  const layouts: Record<string, TerminalLayoutSnapshot> = {}
  const foreground: Record<string, PaneForegroundAgentEntry> = {}
  const tab: Tab = {
    id: 'tab',
    entityId: 'tab',
    groupId: 'group',
    worktreeId: 'wt',
    contentType: 'terminal',
    label: 'Terminal',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    viewMode: 'chat'
  }
  const state = {
    terminalLayoutsByTabId: layouts,
    unifiedTabsByWorktree: { wt: [tab] },
    tabsByWorktree: {},
    settings: { experimentalNativeChat: true },
    pendingPaneAccountRestarts: [],
    runtimePaneTitlesByTabId: { tab: { 1: 'codex', 2: 'codex' } },
    agentStatusByPaneKey: {},
    paneForegroundAgentByPaneKey: foreground,
    setTabLayout: (_id: string, layout: TerminalLayoutSnapshot) => {
      layouts.tab = layout
    },
    setTabViewMode: (_id: string, mode: ViewMode) => {
      state.unifiedTabsByWorktree = { wt: [{ ...tab, viewMode: mode }] }
    },
    toggleTabViewMode: (id: string): void => {
      state.setTabViewMode(
        id,
        state.unifiedTabsByWorktree.wt[0].viewMode === 'chat' ? 'terminal' : 'chat'
      )
    }
  }
  return { state }
})
vi.mock('../../store', async () => {
  const { create } = await import('zustand')
  const { createAgentStatusSlice } = await import('@/store/slices/agent-status')
  const { createTerminalTabPresentationActions } =
    await import('@/store/terminals/terminal-tab-presentation')
  const { terminalLayoutEqual } = await import('../../../../shared/terminal-layout-equality')
  mocks.state.setTabLayout = (id, layout) => {
    if (terminalLayoutEqual(mocks.state.terminalLayoutsByTabId[id], layout)) {
      return
    }
    mocks.state.terminalLayoutsByTabId = { ...mocks.state.terminalLayoutsByTabId, [id]: layout }
    useAppStore.setState({ terminalLayoutsByTabId: mocks.state.terminalLayoutsByTabId })
  }
  mocks.state.setTabViewMode = (_id, mode) => {
    mocks.state.unifiedTabsByWorktree = {
      wt: [{ ...mocks.state.unifiedTabsByWorktree.wt[0], viewMode: mode }]
    }
    useAppStore.setState({ unifiedTabsByWorktree: mocks.state.unifiedTabsByWorktree })
  }
  const useAppStore = create<AppState>()((...args) => {
    const state = {
      ...mocks.state,
      ...createAgentStatusSlice(...args),
      ...createTerminalTabPresentationActions(args[0], args[1]),
      acknowledgedAgentsByPaneKey: {},
      activityClearedAtByPaneKey: {},
      manuallyUnreadTurnsByPaneKey: {},
      sortEpoch: 0,
      workspaceSessionReady: true,
      repos: [],
      worktreesByRepo: {},
      setPaneForegroundAgent: (key: string, entry: PaneForegroundAgentEntry) =>
        args[0]((state) => ({
          paneForegroundAgentByPaneKey: { ...state.paneForegroundAgentByPaneKey, [key]: entry }
        }))
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies the real status slice and every external field read by these mounted hooks; unrelated app services are inert.
    return state as unknown as AppState
  })
  return { useAppStore }
})
vi.mock('@/runtime/web-runtime-terminal-buffer-actions', () => ({
  clearWebRuntimeTerminalBuffer: vi.fn()
}))

export function makeFixture(paneIds = [1, 2], remotePusher?: RemotePaneLayoutPusher) {
  const container = document.createElement('div')
  const split = document.createElement('div')
  split.className = 'pane-split'
  container.append(split)
  const panes = [LEFT, RIGHT].map((leafId, index) => {
    const element = document.createElement('div')
    element.className = 'pane'
    element.dataset.paneId = String(paneIds[index])
    element.dataset.leafId = leafId
    split.append(element)
    return { id: paneIds[index], leafId, container: element }
  })
  const manager = {
    getPanes: () => panes,
    getActivePane: () => panes[0],
    getLeafIdMap: () => new Map(panes.map((pane) => [pane.id, pane.leafId]))
  }
  return {
    managerRef: { current: manager },
    containerRef: { current: container },
    nativeChatTranscriptIsLocalReadable: true,
    onAgentExitedRef: { current: vi.fn() },
    paneCount: 2,
    tabId: 'tab',
    worktreeId: 'wt',
    tabWideAgentHintLeafId: null,
    setTabWideAgentHintLeafId: vi.fn(),
    clearedScrollbackLeafIdsRef: { current: new Set<string>() },
    expandedPaneIdRef: { current: null },
    paneTitles: {},
    paneTitlesRef: { current: {} },
    paneTransportsRef: { current: new Map() },
    remotePaneLayoutPusherRef: { current: remotePusher ?? null },
    removedTitleLeafIdsRef: { current: new Set<string>() },
    setPaneTitles: vi.fn()
  }
}
export function useFixture(fixture: ReturnType<typeof makeFixture>, initialOwner: string | null) {
  const [chatLeafId, setChatLeafId] = useState(initialOwner)
  const input = { ...fixture, chatLeafId, setChatLeafId }
  const chat = useTerminalPaneChatState(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every field read by the chat hook.
    input as unknown as Parameters<typeof useTerminalPaneChatState>[0]
  )
  const layoutInput = { ...input, ...chat, setTabLayout: mocks.state.setTabLayout }
  const layout = useTerminalPaneLayoutPersistence(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every field read by the persistence hook.
    layoutInput as unknown as Parameters<typeof useTerminalPaneLayoutPersistence>[0]
  )
  const projectionInput = {
    ...layoutInput,
    contextMenu: { open: false, menuPaneId: null },
    contextMenuLeafId: RIGHT,
    getContextMenuLeafId: () => RIGHT,
    settings: null,
    isActive: true,
    isVisible: true,
    shouldMeasureHiddenStartup: false,
    sshReconnectOwnsTerminalErrors: false,
    systemPrefersDark: true,
    terminalError: null,
    terminalErrorsByPaneId: {},
    setTerminalError: vi.fn(),
    setTerminalErrorsByPaneId: vi.fn()
  }
  const projection = useTerminalPaneProjection(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies all fields read by the actual projection; unrelated controller actions are inert.
    projectionInput as unknown as Parameters<typeof useTerminalPaneProjection>[0]
  )
  return { ...chat, ...layout, ...projection, chatLeafId, setChatLeafId }
}

export const ownershipFixture = { state: mocks.state }

export function terminalChatProcessRows(
  foreground: 'agent' | 'shell' | 'unknown'
): ProcessTableRow[] {
  return foreground === 'unknown'
    ? []
    : [
        {
          pid: 100,
          ppid: 1,
          pgid: 100,
          tpgid: foreground === 'agent' ? 101 : 100,
          tty: 'ttys004',
          startTime: 'shell-birth',
          stat: 'Ss',
          command: '-zsh'
        },
        {
          pid: 101,
          ppid: 100,
          pgid: 101,
          tpgid: foreground === 'agent' ? 101 : 100,
          tty: 'ttys004',
          startTime: 'agent-birth',
          stat: foreground === 'agent' ? 'S+' : 'T',
          command: 'codex'
        }
      ]
}

beforeEach(() => {
  useAppStore.setState({
    paneForegroundAgentByPaneKey: {},
    terminalInterfaceByPtyId: {},
    agentLaunchConfigByPaneKey: {},
    agentStatusByPaneKey: {},
    suppressedPtyExitIds: {},
    pendingStartupByTabId: {},
    automaticAgentResumeClaimsByTabId: {}
  })
  mocks.state.settings.experimentalNativeChat = true
  mocks.state.runtimePaneTitlesByTabId.tab = { 1: 'codex', 2: 'codex' }
  mocks.state.setTabViewMode('tab', 'chat')
  mocks.state.setTabLayout('tab', {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEFT },
      second: { type: 'leaf', leafId: RIGHT }
    },
    activeLeafId: LEFT,
    expandedLeafId: null,
    chatLeafId: RIGHT
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
