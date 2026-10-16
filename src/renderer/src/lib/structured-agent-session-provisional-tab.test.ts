import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import type { AgentSessionLaunchPlan } from './agent-session-launch-plan'
import type { StructuredAgentLaunchSettlement } from './structured-agent-launch-settlement'

const mocks = vi.hoisted(() => ({
  createUnifiedTab: vi.fn(),
  closeUnifiedTab: vi.fn(),
  createSupport: vi.fn(),
  requestFocus: vi.fn(),
  cancelFocus: vi.fn(),
  draftText: { value: '' }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      unifiedTabsByWorktree: {},
      activeGroupIdByWorktree: {},
      createUnifiedTab: mocks.createUnifiedTab,
      closeUnifiedTab: mocks.closeUnifiedTab,
      setActiveTabType: vi.fn()
    })
  }
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: (_target: unknown, method: string) =>
    method === 'agentSession.createSupport' ? mocks.createSupport() : new Promise(() => undefined)
}))

vi.mock('@/components/native-chat/native-chat-composer-draft-store', () => ({
  readNativeChatComposerDraft: () => ({ text: mocks.draftText.value, images: [] }),
  structuredAgentSessionDraftScopeKey: (sessionId: string) => `agent-session:${sessionId}`
}))

import { beginStructuredAgentSessionProvisionalLaunch } from './structured-agent-session-provisional-tab'
import { StructuredAgentSessionCreateRefusalError } from './structured-agent-session-launch-errors'

function planSettlingAs(
  settlement: StructuredAgentLaunchSettlement,
  prompt?: string
): AgentSessionLaunchPlan {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: begin() is the only member this path calls.
  return {
    route: 'structured-native-chat',
    agent: 'claude',
    worktreeId: 'wt-1',
    executionHostId: 'local',
    ...(prompt ? { prompt } : {}),
    begin: () => ({
      sessionId: 'claude_1',
      executionHostId: 'local',
      settlement: Promise.resolve(settlement),
      cancel: vi.fn()
    }),
    launch: vi.fn()
  } as unknown as AgentSessionLaunchPlan
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createUnifiedTab.mockImplementation(
    (worktreeId: string, _type: string, tab: Partial<Tab>) => ({ ...tab, worktreeId })
  )
  mocks.createSupport.mockResolvedValue({ supported: true })
  mocks.draftText.value = ''
})

const declined = (): StructuredAgentLaunchSettlement => ({
  kind: 'failed',
  error: new StructuredAgentSessionCreateRefusalError('no', 'structured_agent_session_unsupported')
})

describe('a provisional structured chat tab', () => {
  it('opens a New Chat at once and focuses it; the launch asks the host itself', async () => {
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: planSettlingAs({ kind: 'structured', sessionId: 'claude_1' }),
      hooks: {},
      focusIntent: { request: mocks.requestFocus, cancel: mocks.cancelFocus },
      targetGroupId: 'group-2'
    })

    expect(mocks.createUnifiedTab).toHaveBeenCalledWith(
      'wt-1',
      'agent-session',
      expect.objectContaining({ executionHostId: 'local', targetGroupId: 'group-2' })
    )
    expect(mocks.requestFocus).toHaveBeenCalledExactlyOnceWith('structured-agent-session-claude_1')
    await expect(launch?.settlement).resolves.toEqual({ kind: 'structured', sessionId: 'claude_1' })
    expect(mocks.createSupport).not.toHaveBeenCalled()
  })

  it.each([
    ['nobody typed: its terminal opens in its place', '', { kind: 'terminal' }],
    ['typed in: the chat keeps it', 'half a thought', { kind: 'failed' }]
  ])('a New Chat its host refuses, %s', async (_name, typed, settled) => {
    const onHostDeclined = vi.fn(() => ({ opened: true }))
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: planSettlingAs(declined()),
      hooks: {},
      focusIntent: { request: mocks.requestFocus, cancel: mocks.cancelFocus },
      onHostDeclined
    })
    mocks.draftText.value = typed

    await expect(launch?.settlement).resolves.toMatchObject(settled)
    expect(onHostDeclined).toHaveBeenCalledTimes(typed ? 0 : 1)
    expect(mocks.closeUnifiedTab).toHaveBeenCalledTimes(typed ? 0 : 1)
  })

  it('asks first for a launch that carries a prompt, so a "no" can hand it on', async () => {
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: planSettlingAs({ kind: 'structured', sessionId: 'claude_1' }, 'review this'),
      hooks: {},
      focusIntent: { request: mocks.requestFocus, cancel: mocks.cancelFocus },
      targetGroupId: 'group-2'
    })

    expect(launch?.tab).toBeNull()
    expect(mocks.createUnifiedTab).not.toHaveBeenCalled()
    expect(mocks.requestFocus).not.toHaveBeenCalled()
    await expect(launch?.settlement).resolves.toEqual({ kind: 'structured', sessionId: 'claude_1' })
    expect(mocks.createSupport).toHaveBeenCalledOnce()
    expect(mocks.createUnifiedTab).toHaveBeenCalledWith(
      'wt-1',
      'agent-session',
      expect.objectContaining({ executionHostId: 'local', targetGroupId: 'group-2' })
    )
    expect(mocks.requestFocus).toHaveBeenCalledExactlyOnceWith('structured-agent-session-claude_1')
    expect(mocks.cancelFocus).not.toHaveBeenCalled()
  })
})
