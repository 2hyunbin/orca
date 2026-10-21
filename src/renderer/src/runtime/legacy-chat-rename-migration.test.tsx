// @vitest-environment happy-dom
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type * as LayoutRouting from '@/store/terminals/tab-change-through-layout-owner'
import {
  addWorkspace,
  emptySession
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import { renameTab } from '../../../shared/workspace-layout/workspace-layout-tab-commands'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import { makeWorktree, makeUnifiedTab, TEST_REPO } from '@/store/slices/store-test-helpers'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { WorkspaceAttachmentOrigins } from '@/components/sidebar/WorkspaceAttachmentOrigins'
import { useAppStore } from '@/store'
import { installLegacyChatRenameMigration } from './legacy-chat-rename-migration'
import { uploadLegacyStructuredChatRename } from './structured-chat-rename'
import { readStructuredChatTabName } from './structured-chat-tab-name'
import {
  subscribeStructuredChatTabNames,
  getStructuredChatTabNames
} from './structured-chat-name-observation'
import { useLiveDashboardSnapshot } from '@/components/dashboard/useLiveDashboardSnapshot'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from '@/lib/workspace-session-host-hydration'

const mock = vi.hoisted(() => ({
  rpc: vi.fn(),
  layout: vi.fn<typeof LayoutRouting.sendTabChangeToLayoutOwner>(),
  contacts: new Set<() => void>(),
  listeners: new Set<() => void>(),
  snapshot: new Map<string, AgentSessionStatusSummary>(),
  paired: new Map<string, AgentSessionStatusSummary>(),
  activates: vi.fn(),
  deactivates: vi.fn()
}))
vi.mock('@/store', async () => ({
  useAppStore: (await import('@/store/slices/store-test-helpers')).createTestStore()
}))
vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc: mock.rpc }))
vi.mock('./structured-agent-session-client', () => ({
  supportsStructuredAgentSessionRename: async () => true
}))
vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/store/terminals/tab-change-through-layout-owner', () => ({
  sendTabChangeToLayoutOwner: mock.layout
}))
vi.mock('./local-runtime-capabilities', () => ({
  subscribeLocalRuntimeCapabilitiesKnown: () => () => {}
}))
vi.mock('./runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: (_id: string, listener: () => void) => {
    mock.contacts.add(listener)
    return () => mock.contacts.delete(listener)
  }
}))
vi.mock('./structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: (target: RuntimeClientTarget) => ({
    getSnapshot: () => (target.kind === 'local' ? mock.snapshot : mock.paired),
    getNamingSnapshot: () => (target.kind === 'local' ? mock.snapshot : mock.paired),
    activate: () => {
      mock.activates()
      return mock.deactivates
    },
    subscribe: (listener: () => void) => {
      mock.listeners.add(listener)
      return () => mock.listeners.delete(listener)
    }
  })
}))

const workspace = makeWorktree({ id: 'repo::/tmp/rename-migration', repoId: 'repo' })
const chat = (extra: Partial<Tab> = {}): Tab =>
  makeUnifiedTab({
    id: 'chat-tab',
    entityId: 'session-1',
    worktreeId: workspace.id,
    groupId: 'group',
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Codex Chat',
    ...extra
  })
function loadChat(tab: Tab, owner: string) {
  const stored = addWorkspace(emptySession(), workspace.id, [
    {
      id: 'group',
      tabs: [{ id: tab.id, entityId: tab.entityId, kind: 'agent-session', entry: tab }]
    }
  ])
  return loadWorkspaceLayoutWithoutReport(owner, stored, nameBasedLoadContext())
}
function seed(tab: Tab) {
  useAppStore.setState({
    workspaceSessionReady: true,
    repos: [{ ...TEST_REPO, id: 'repo' }],
    worktreesByRepo: { repo: [workspace] },
    unifiedTabsByWorktree: { [tab.worktreeId]: [tab] }
  })
}
const stops: (() => void)[] = []
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  mock.activates.mockClear()
  mock.deactivates.mockClear()
  mock.rpc.mockReset()
  mock.layout.mockReset()
  mock.layout.mockReturnValue(false)
})
afterEach(() => {
  cleanup()
  stops.splice(0).forEach((stop) => stop())
  mock.snapshot.clear()
  mock.paired.clear()
})

it('migrates an inactive restored alias after reconnect and clears both saved copies only after acknowledgment', async () => {
  const alias = 'x'.repeat(5000)
  const tab = chat({ executionHostId: 'runtime:paired', customLabel: alias })
  let loaded = loadChat(tab, 'runtime:paired')
  mock.layout.mockImplementation((_state, target, change, _local, answers) => {
    if (!target) {
      throw new Error('Missing tab')
    }
    const command = change(target.id)
    if (command.type !== 'renameTab') {
      throw new Error('Unexpected layout command')
    }
    const result = renameTab(loaded.layout, { ...command, workspace: target.worktreeId })
    if (!result.ok) {
      throw new Error('Layout refused cleanup')
    }
    loaded = { ...loaded, layout: result.model }
    answers?.shown?.()
    return true
  })
  seed(tab)
  mock.rpc
    .mockRejectedValueOnce(new Error('Disconnected'))
    .mockResolvedValue({ name: 'x'.repeat(200), applied: true })
  stops.push(installLegacyChatRenameMigration())
  await waitFor(() => expect(mock.rpc).toHaveBeenCalledTimes(1))
  expect(useAppStore.getState().unifiedTabsByWorktree[workspace.id]?.[0]?.customLabel).toBe(alias)
  mock.contacts.forEach((regained) => regained())
  await waitFor(() =>
    expect(useAppStore.getState().unifiedTabsByWorktree[workspace.id]?.[0]?.customLabel).toBeNull()
  )
  expect(mock.rpc).toHaveBeenLastCalledWith(expect.anything(), 'agentSession.rename', {
    sessionId: tab.entityId,
    name: 'x'.repeat(200),
    legacyAlias: true
  })
  expect(saveWorkspaceLayout(loaded).unifiedTabs?.[workspace.id]?.[0]?.customLabel).toBeNull()
})

it('retains a replacement alias when main receives an older session cleanup', async () => {
  const tab = chat({ customLabel: 'Legacy' })
  seed(tab)
  const loaded = loadChat({ ...tab, entityId: 'replacement' }, 'local')
  mock.rpc.mockResolvedValue({ name: 'Legacy', applied: true })
  mock.layout.mockImplementation((_state, target, change, _local, answers) => {
    if (!target) {
      throw new Error('Missing tab')
    }
    const command = change(target.id)
    if (command.type !== 'renameTab') {
      throw new Error('Unexpected command')
    }
    expect(renameTab(loaded.layout, { ...command, workspace: target.worktreeId }).ok).toBe(false)
    answers?.refused?.()
    return true
  })
  expect(await uploadLegacyStructuredChatRename(useAppStore.getState, tab, 'Legacy')).toBe(false)
  expect(saveWorkspaceLayout(loaded).unifiedTabs?.[workspace.id]?.[0]?.customLabel).toBe('Legacy')
  expect(useAppStore.getState().unifiedTabsByWorktree[workspace.id]?.[0]?.customLabel).toBe(
    'Legacy'
  )
})

function seedTwin(tab: Tab) {
  seed(tab)
  const folder = makeFolderWorkspace({ id: 'twin' })
  const paneKey = makePaneKey(tab.id, '11111111-1111-4111-8111-111111111111')
  useAppStore.setState({
    activeWorktreeId: tab.worktreeId,
    activeWorkspaceExecutionHostId: 'runtime:paired',
    folderWorkspaces: [
      { ...folder, executionHostId: 'local' },
      { ...folder, executionHostId: 'runtime:paired' }
    ],
    agentStatusByPaneKey: {
      [paneKey]: {
        paneKey,
        tabId: tab.id,
        worktreeId: tab.worktreeId,
        agentType: 'codex',
        state: 'working',
        prompt: '',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        stateHistory: []
      }
    }
  })
}
function name(tab: Tab, conversationName: string): AgentSessionStatusSummary {
  return {
    sessionId: tab.entityId,
    workspaceId: tab.worktreeId,
    agent: 'codex',
    status: null,
    latestPrompt: '',
    updatedAt: 1,
    conversationName
  }
}

it('shares qualified current names with live dashboard and attachments without activating plain reads', () => {
  const tab = chat({ worktreeId: 'folder:twin' })
  seedTwin(tab)
  mock.snapshot = new Map([[tab.entityId, name(tab, 'Same')]])
  mock.paired = new Map([[tab.entityId, name(tab, 'Same')]])
  const attached = chat({ id: 'attached-tab', executionHostId: 'runtime:paired' })
  useAppStore.setState((state) => ({
    unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, [workspace.id]: [attached] }
  }))
  const before = getStructuredChatTabNames()
  expect(getStructuredChatTabNames()).toBe(before)
  expect(before.get(tab)).toMatchObject({ owner: 'runtime:paired', savedName: 'Same' })
  expect(mock.activates).not.toHaveBeenCalled()
  stops.push(useAppStore.subscribe(() => getStructuredChatTabNames()))
  const changed = vi.fn()
  const stop = subscribeStructuredChatTabNames(changed)
  const view = render(
    <WorkspaceAttachmentOrigins
      workspace={{ ...workspace, hostId: 'runtime:paired' }}
      item={{
        provider: 'github',
        type: 'issue',
        number: 1,
        origins: [{ kind: 'observed', tabId: attached.id, hostId: 'runtime:paired' }]
      }}
    />
  )
  const dashboard = renderHook(useLiveDashboardSnapshot)
  const shown = () =>
    dashboard.result.current.cards.find((card) => card.tabId === tab.id)?.conversationName
  expect(shown()).toBe('Same')
  expect(view.container.textContent).toContain('Same')
  expect(mock.activates).toHaveBeenCalledTimes(1)
  act(() => useAppStore.setState({ agentStatusEpoch: 1 }))
  expect(getStructuredChatTabNames()).toBe(before)
  act(() => useAppStore.setState({ activeWorkspaceExecutionHostId: 'local' }))
  expect(getStructuredChatTabNames()).not.toBe(before)
  expect(getStructuredChatTabNames().get(tab)?.owner).toBe('local')
  act(() => {
    mock.snapshot = new Map([[tab.entityId, name(tab, 'Local renamed')]])
    mock.listeners.forEach((notify) => notify())
  })
  expect(shown()).toBe('Local renamed')
  const local = getStructuredChatTabNames()
  act(() => {
    mock.paired = new Map([[tab.entityId, name(tab, 'Unrelated')]])
    mock.listeners.forEach((notify) => notify())
  })
  expect(getStructuredChatTabNames().get(tab)).toEqual(local.get(tab))
  expect(view.container.textContent).toContain('Unrelated')
  expect(shown()).toBe('Local renamed')
  act(() => useAppStore.setState({ activeWorktreeId: 'elsewhere' }))
  expect(getStructuredChatTabNames().get(tab)?.owner).toBeNull()
  expect(shown()).toBe('Codex Chat')
  const replacement = { ...tab }
  act(() => useAppStore.setState({ unifiedTabsByWorktree: { [tab.worktreeId]: [replacement] } }))
  expect(getStructuredChatTabNames().has(tab)).toBe(false)
  expect(getStructuredChatTabNames().has(replacement)).toBe(true)
  dashboard.unmount()
  view.unmount()
  expect(mock.deactivates).toHaveBeenCalledTimes(2)
  stop()
  mock.paired = new Map([[tab.entityId, name(tab, 'Dormant rename')]])
  useAppStore.setState({
    activeWorktreeId: tab.worktreeId,
    activeWorkspaceExecutionHostId: 'runtime:paired'
  })
  expect(getStructuredChatTabNames().get(replacement)?.savedName).toBe('Dormant rename')
  expect(readStructuredChatTabName(replacement, useAppStore.getState())).toBe('Dormant rename')
  expect(mock.activates).toHaveBeenCalledTimes(2)
})

it('traces a previous-build alias through real partition restoration and migration before inventory', async () => {
  const tab = chat({ worktreeId: 'folder:twin', customLabel: 'Legacy paired' })
  seedTwin(tab)
  useAppStore.setState({ workspaceSessionReady: false })
  const local = {
    ...emptySession(),
    activeWorktreeId: tab.worktreeId,
    activeWorkspaceKey: 'folder:twin' as const,
    activeWorkspaceExecutionHostId: 'runtime:paired' as const
  }
  const paired = { ...emptySession(), unifiedTabs: { [tab.worktreeId]: [tab] } }
  const restored = await fetchWorkspaceSessionWithRuntimeHostOwners(
    { get: async (host) => (host ? paired : local) },
    [],
    ['runtime:paired']
  )
  useAppStore.getState().hydrateWorkspaceSession(restored.session, restored)
  useAppStore.getState().hydrateTabsSession(restored.session)
  expect(useAppStore.getState().restoredRuntimeHostIdByWorkspaceSessionKey[tab.worktreeId]).toBe(
    'runtime:paired'
  )
  const current = () => useAppStore.getState().unifiedTabsByWorktree[tab.worktreeId][0]
  expect(current().executionHostId).toBeUndefined()
  mock.paired = new Map([[tab.entityId, name(tab, 'Legacy paired')]])
  mock.rpc.mockResolvedValue({ name: 'Legacy paired', applied: true })
  await useAppStore.getState().reconnectPersistedTerminals()
  stops.push(installLegacyChatRenameMigration())
  await waitFor(() => expect(current().customLabel).toBeNull())
  expect(readStructuredChatTabName(current(), useAppStore.getState())).toBe('Legacy paired')
  useAppStore.setState({ activeWorktreeId: 'elsewhere' })
  expect(readStructuredChatTabName(current(), useAppStore.getState())).toBe('Codex Chat')
})
