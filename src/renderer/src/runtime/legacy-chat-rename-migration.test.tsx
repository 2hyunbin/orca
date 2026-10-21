// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
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
import { makeWorktree } from '@/store/slices/store-test-helpers'
import { WorkspaceAttachmentOrigins } from '@/components/sidebar/WorkspaceAttachmentOrigins'
import { useAppStore } from '@/store'
import { installLegacyChatRenameMigration } from './legacy-chat-rename-migration'
import { uploadLegacyStructuredChatRename } from './structured-chat-rename'
import { readStructuredChatTabName } from './structured-chat-tab-name'
import { subscribeStructuredChatTabNames } from './structured-chat-name-observation'
import { rowConversationName } from '@/components/dashboard/dashboard-card-labels'

const mock = vi.hoisted(() => ({
  rpc: vi.fn(),
  layout: vi.fn<typeof LayoutRouting.sendTabChangeToLayoutOwner>(),
  contacts: new Set<() => void>(),
  listeners: new Set<() => void>(),
  snapshot: new Map<string, AgentSessionStatusSummary>()
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
  getStructuredAgentSessionStatusFeed: () => ({
    getSnapshot: () => mock.snapshot,
    getNamingSnapshot: () => mock.snapshot,
    activate: () => () => {},
    subscribe: (listener: () => void) => {
      mock.listeners.add(listener)
      return () => mock.listeners.delete(listener)
    }
  })
}))

const workspace = makeWorktree({ id: 'repo::/tmp/rename-migration', repoId: 'repo' })
const chat = (extra: Partial<Tab> = {}): Tab => ({
  id: 'chat-tab',
  entityId: 'session-1',
  worktreeId: workspace.id,
  groupId: 'group',
  contentType: 'agent-session',
  agentSessionAgent: 'codex',
  label: 'Codex Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1,
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
    repos: [
      {
        id: 'repo',
        path: '/tmp/rename-migration',
        displayName: 'repo',
        badgeColor: '',
        addedAt: 1
      }
    ],
    worktreesByRepo: { repo: [workspace] },
    unifiedTabsByWorktree: { [workspace.id]: [tab] }
  })
}
const stops: (() => void)[] = []
beforeEach(() => {
  mock.rpc.mockReset()
  mock.layout.mockReset()
  mock.layout.mockReturnValue(false)
})
afterEach(() => {
  cleanup()
  stops.splice(0).forEach((stop) => stop())
  mock.snapshot.clear()
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

it('updates mounted attachment labels and cached readers from the owning feed for an unstamped tab', () => {
  const tab = chat()
  seed(tab)
  const summary: AgentSessionStatusSummary = {
    sessionId: tab.entityId,
    workspaceId: workspace.id,
    agent: 'codex',
    status: null,
    latestPrompt: '',
    updatedAt: 1,
    conversationName: 'Before'
  }
  mock.snapshot.set(tab.entityId, summary)
  const changed = vi.fn()
  stops.push(subscribeStructuredChatTabNames(changed))
  const view = render(
    <WorkspaceAttachmentOrigins
      workspace={workspace}
      item={{
        provider: 'github',
        type: 'issue',
        number: 1,
        origins: [{ kind: 'observed', tabId: tab.id, hostId: 'local' }]
      }}
    />
  )
  expect(view.container.textContent).toContain('Before')
  changed.mockClear()
  act(() => {
    mock.snapshot = new Map([[tab.entityId, { ...summary, conversationName: 'After' }]])
    mock.listeners.forEach((notify) => notify())
  })
  expect(view.container.textContent).toContain('After')
  expect(readStructuredChatTabName(tab, useAppStore.getState())).toBe('After')
  expect(changed).toHaveBeenCalledOnce()
  expect(
    rowConversationName(
      {
        paneKey: 'chat-tab:session',
        agentType: 'codex',
        state: 'working',
        startedAt: 1,
        entry: {
          paneKey: 'chat-tab:session',
          agentType: 'codex',
          state: 'working',
          stateHistory: [],
          prompt: '',
          updatedAt: 1,
          stateStartedAt: 1
        },
        tab: {
          id: tab.id,
          worktreeId: tab.worktreeId,
          title: tab.label,
          customTitle: null,
          ptyId: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      },
      true,
      undefined,
      undefined,
      useAppStore.getState()
    )
  ).toBe('After')
})
