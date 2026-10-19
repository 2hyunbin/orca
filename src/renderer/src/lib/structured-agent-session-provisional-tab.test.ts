// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type * as launchModule from './launch-structured-agent-session'
import type { AgentSessionLaunchPlan } from './agent-session-launch-plan'
import { adoptAgentSessionLaunchVerdict } from './agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from './structured-agent-session-provisional-tab'
import { StructuredAgentSessionCreateRefusalError } from './structured-agent-session-launch-errors'
import { act, renderHook } from '@testing-library/react'
import { useNativeChatProvisionalLaunch } from '@/components/native-chat/use-native-chat-provisional-launch'
import {
  getStructuredAgentSessionLaunchFailure,
  resetStructuredAgentLaunchRegistryForTests
} from './structured-agent-session-launch-registry'
import { structuredSessionNotices } from '@/components/native-chat/native-chat-structured-session-notices'
import type { AgentTerminalLaunchCompletion } from './structured-agent-session-launch-admission'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests
} from '@/components/native-chat/native-chat-pending-attachment-cache'

const mocks = vi.hoisted(() => ({ text: '', focus: vi.fn(), toast: vi.fn(), launch: vi.fn() }))
vi.mock('./launch-structured-agent-session', async (original) => ({
  ...(await original<typeof launchModule>()),
  launchStructuredAgentSession: mocks.launch
}))
vi.mock('sonner', () => ({ toast: { info: mocks.toast, error: vi.fn() } }))
vi.mock('./focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('@/components/native-chat/native-chat-composer-draft-store', () => ({
  readNativeChatComposerDraft: () => ({ text: mocks.text, images: [] }),
  resolveNativeChatComposerDraftOwner: () => undefined,
  structuredAgentSessionDraftScopeKey: (id: string) => `agent-session:${id}`
}))

function planSettlingAs(error: StructuredAgentSessionCreateRefusalError): AgentSessionLaunchPlan {
  mocks.launch.mockRejectedValue(error)
  return adoptAgentSessionLaunchVerdict({
    requestId: 'action',
    route: 'structured-native-chat',
    agent: 'claude',
    worktreeId: 'wt-1',
    executionHostId: 'local'
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.text = ''
  resetStructuredAgentLaunchRegistryForTests()
  clearNativeChatPendingAttachmentsForTests()
  useAppStore.setState({
    activeWorktreeId: 'wt-1',
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    tabsByWorktree: {},
    tabBarOrderByWorktree: {}
  })
})

function openChat(requestedSurface?: 'chat') {
  let complete!: (value: AgentTerminalLaunchCompletion) => void
  const completion = new Promise<AgentTerminalLaunchCompletion>((resolve) => {
    complete = resolve
  })
  const fallback = vi.fn(() => ({ opened: true, completion }))
  const launch = beginStructuredAgentSessionProvisionalLaunch({
    plan: {
      ...planSettlingAs(new StructuredAgentSessionCreateRefusalError('no')),
      requestedSurface
    },
    hooks: {},
    focusIntent: { request: mocks.focus, cancel: vi.fn() },
    onHostDeclined: fallback
  })
  const chat = launch?.tab
  if (!chat) {
    throw new Error('No immediate chat')
  }
  return { launch, chat, fallback, complete }
}

describe('a provisional structured chat tab', () => {
  it.each([
    'empty',
    'typed-before',
    'typed-during',
    'pending-chip',
    'failed',
    'unreconciled',
    'closed',
    'explicit',
    'away-before',
    'away-during',
    'closed-during'
  ])('owns the destination through terminal completion: %s', async (scenario) => {
    if (scenario === 'typed-before') {
      mocks.text = 'keep this'
    }
    const { launch, chat, fallback, complete } = openChat(
      scenario === 'explicit' ? 'chat' : undefined
    )
    expect(mocks.focus).toHaveBeenCalledWith(chat.id)
    const view = renderHook(() => {
      const current = useNativeChatProvisionalLaunch('wt-1', chat.entityId)
      return structuredSessionNotices({
        launch: current,
        agentLabel: 'Claude',
        sessionError: null,
        composerError: null
      })
    })
    const away = () => {
      useAppStore.getState().createUnifiedTab('wt-2', 'agent-session', { entityId: 'other' })
      useAppStore.setState({ activeWorktreeId: 'wt-2', activeTabType: 'agent-session' })
    }
    if (scenario === 'away-before') {
      away()
    }
    if (scenario === 'closed') {
      useAppStore.getState().closeUnifiedTab(chat.id)
    }
    await vi.waitFor(() =>
      expect(
        scenario === 'closed' || scenario === 'explicit' || fallback.mock.calls.length
      ).toBeTruthy()
    )
    if (scenario === 'closed' || scenario === 'explicit') {
      await launch?.settlement
      expect(fallback).not.toHaveBeenCalled()
      view.unmount()
      return
    }
    expect(useAppStore.getState().unifiedTabsByWorktree['wt-1']).toContainEqual(chat)
    // Move the source while its host is preparing the terminal, then invest in the composer.
    const sibling = useAppStore.getState().createUnifiedTab('wt-1', 'terminal', {
      entityId: 'sibling',
      split: { sourceGroupId: chat.groupId, splitDirection: 'right', activate: true }
    })
    const groupId = sibling.groupId
    useAppStore.getState().moveUnifiedTabToGroup(chat.id, groupId)
    useAppStore.getState().reorderUnifiedTabs(groupId, [chat.id, sibling.id])
    if (scenario === 'typed-during') {
      mocks.text = 'new thought'
    }
    if (scenario === 'pending-chip') {
      addNativeChatPendingAttachment(`agent-session:${chat.entityId}`, {
        id: 'paste',
        path: '',
        pending: true
      })
    }
    if (scenario === 'away-during') {
      away()
    }
    if (scenario === 'closed-during') {
      useAppStore.getState().closeUnifiedTab(chat.id)
    }
    const priorFailure = getStructuredAgentSessionLaunchFailure('wt-1', chat.entityId)
    const selected = useAppStore.getState().getActiveTab('wt-2')
    const terminal =
      scenario === 'failed' || scenario === 'unreconciled'
        ? null
        : useAppStore
            .getState()
            .createUnifiedTab('wt-1', 'terminal', { entityId: 'replacement', activate: false })
    await act(async () => {
      complete({
        outcome:
          scenario === 'failed' ? { status: 'failed', message: 'offline' } : { status: 'created' },
        tabId: terminal?.id ?? 'missing'
      })
      await launch?.settlement
    })
    const state = useAppStore.getState()
    const tabs = state.unifiedTabsByWorktree['wt-1'] ?? []
    expect(tabs.some((t) => t.id === chat.id)).toBe(
      !['empty', 'away-before', 'away-during', 'closed-during'].includes(scenario)
    )
    if (terminal) {
      const order = state.groupsByWorktree['wt-1']?.find((g) => g.id === groupId)?.tabOrder
      expect(order).toEqual(
        scenario === 'closed-during'
          ? [sibling.id, terminal.id]
          : ['empty', 'away-before', 'away-during'].includes(scenario)
            ? [terminal.id, sibling.id]
            : [chat.id, terminal.id, sibling.id]
      )
      expect(mocks.toast).toHaveBeenCalledOnce()
    }
    expect(view.result.current[0]?.text ?? '').not.toMatch(/open the agent|open it in/i)
    if (scenario === 'unreconciled') {
      expect(getStructuredAgentSessionLaunchFailure('wt-1', chat.entityId)).not.toBe(priorFailure)
      expect(view.result.current[0]?.text).toContain("hasn't appeared")
      expect(mocks.toast).not.toHaveBeenCalled()
    }
    if (scenario.startsWith('away-')) {
      expect(state.activeWorktreeId).toBe('wt-2')
      expect(state.activeTabType).toBe('agent-session')
      expect(state.getActiveTab('wt-2')).toEqual(selected)
    }
    view.unmount()
    expect(mocks.text).toBe(
      scenario === 'typed-before' ? 'keep this' : scenario === 'typed-during' ? 'new thought' : ''
    )
  })
})
