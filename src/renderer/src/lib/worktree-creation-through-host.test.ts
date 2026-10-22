import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from './pending-worktree-creation'
import type { AgentLaunchResult } from '../../../shared/agent-launch-intent'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'

const mocks = vi.hoisted(() => {
  const pendingWorktreeCreations: Record<string, unknown> = { 'creation-1': {} }
  return {
    capabilities: vi.fn(),
    rpc: vi.fn(),
    send: vi.fn(),
    draft: vi.fn(),
    close: vi.fn(),
    reveal: vi.fn(),
    ready: vi.fn(),
    complete: vi.fn(),
    refresh: vi.fn(),
    state: {
      repos: [{ id: 'repo-1', executionHostId: 'local' }],
      settings: {},
      sortBy: 'manual',
      activeView: 'terminal',
      activePendingCreationId: 'creation-1',
      activeWorktreeId: null,
      pendingWorktreeCreations,
      updatePendingWorktreeCreation: vi.fn(),
      closeUnifiedTab: vi.fn(),
      seedNativeChatLaunchDraft: vi.fn()
    }
  }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: mocks.capabilities
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.rpc,
  getRuntimeEnvironmentStatus: vi.fn()
}))
vi.mock('@/store/slices/worktrees/create/worktree-create-parent-pick', () => ({
  resolveWorktreeCreateParent: () => ({ staleBeforeCreate: false }),
  notifyWorktreeParentDropped: vi.fn()
}))
vi.mock('@/lib/worktree-creation-host-result', () => ({
  acceptHostCreatedWorktree: (_target: unknown, launch: AgentLaunchResult) => launch.created,
  materializeHostCreatedWorktree: mocks.refresh
}))
vi.mock('@/components/native-chat/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: vi.fn()
}))
vi.mock('@/components/native-chat/structured-agent-session-message-sender', () => ({
  sendStructuredAgentSessionMessage: mocks.send
}))
vi.mock('@/runtime/structured-agent-session-tab-retirement', () => ({
  beginStructuredAgentSessionTabClose: mocks.close
}))
vi.mock('@/lib/agent-launch-prompt-delivery', () => ({ deliverLaunchPromptToAgentTab: vi.fn() }))
vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: vi.fn()
}))
vi.mock('@/lib/worktree-creation-background-mount', () => ({
  mountCreatedWorktreeStartupTabsInBackground: vi.fn()
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: mocks.reveal }))
vi.mock('@/lib/worktree-creation-ready-toast', () => ({
  showWorktreeCreationReadyToast: mocks.ready
}))
vi.mock('@/lib/worktree-creation-completion', () => ({ completeWorktreeCreation: mocks.complete }))

import { createWorktreeThroughHost } from './worktree-creation-through-host'

const capabilities = [
  'agent.launch.v2',
  'agent.launch.replay-required.v1',
  'agent.launch.surface.v1',
  'agent.launch.desktop-create.v1'
]
const result: AgentLaunchResult = {
  worktreeId: 'wt-1',
  created: { worktree: makeWorktree({ id: 'wt-1', repoId: 'repo-1' }) },
  outcome: { kind: 'structured', sessionId: 'claude_created', handle: 'chat_created' },
  receipt: {
    mode: 'structured',
    preferred: 'structured',
    reason: 'requested',
    detail: 'Chat requested'
  }
}
function request(): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'feature',
    setupDecision: 'inherit',
    agent: 'claude',
    agentLaunchRoute: 'structured-native-chat',
    pendingFirstAgentMessageRename: true,
    note: '',
    startupPlan: null,
    quickPrompt: 'Fix the bug',
    quickTelemetry: null
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.capabilities.mockResolvedValue(capabilities)
  mocks.rpc.mockResolvedValue(result)
  mocks.send.mockReturnValue({})
  mocks.state.pendingWorktreeCreations = { 'creation-1': {} }
  mocks.state.activePendingCreationId = 'creation-1'
  mocks.state.seedNativeChatLaunchDraft = mocks.draft
})

describe('desktop shared worktree create', () => {
  it('creates at rest through the host and only then sends through the ordinary chat sender', async () => {
    await expect(createWorktreeThroughHost('creation-1', request())).resolves.toBe(true)
    expect(mocks.rpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'agent.launchReplay',
      expect.objectContaining({
        operationId: expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/),
        sessionId: expect.stringMatching(/^claude_/),
        surface: 'chat',
        target: {
          kind: 'create-worktree',
          create: expect.objectContaining({
            repo: 'repo-1',
            creationId: 'creation-1',
            pendingFirstAgentMessageRename: true
          })
        }
      }),
      { timeoutMs: 600_000 }
    )
    expect(mocks.rpc.mock.calls[0]?.[2]).not.toHaveProperty('prompt')
    expect(mocks.send).toHaveBeenCalledWith({
      sessionId: 'claude_created',
      target: { kind: 'local' },
      text: 'Fix the bug'
    })
    expect(mocks.refresh).toHaveBeenCalledBefore(mocks.send)
    expect(mocks.reveal).toHaveBeenCalledOnce()
  })

  it('returns to the old renderer path before any effect if one required capability is absent', async () => {
    mocks.capabilities.mockResolvedValue(capabilities.slice(0, -1))
    const pending = request()
    await expect(createWorktreeThroughHost('creation-1', pending)).resolves.toBe(false)
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(pending.hostAgentLaunch).toBeUndefined()
  })

  it.each<Partial<WorktreeCreationRequest>>([
    { ephemeralVmCheckoutMode: 'provisioned-root' },
    { ephemeralVmRuntimeId: 'vm-1' },
    { ephemeralVmRecipe: { sourceRepoId: 'repo-1', recipeId: 'recipe-1', projectId: 'project-1' } }
  ])('keeps special workspace creation on its existing route: %j', async (specialCreate) => {
    await expect(
      createWorktreeThroughHost('creation-1', { ...request(), ...specialCreate })
    ).resolves.toBe(false)
    expect(mocks.capabilities).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('closes a dismissed at-rest chat without sending or revealing the workspace', async () => {
    mocks.rpc.mockImplementation(async () => {
      mocks.state.pendingWorktreeCreations = {}
      return result
    })
    await createWorktreeThroughHost('creation-1', request())
    expect(mocks.close).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'claude_created', provisional: true })
    )
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.reveal).not.toHaveBeenCalled()
  })

  it('keeps moved-away creation in the background and places a draft in its chat composer', async () => {
    mocks.state.activePendingCreationId = 'other-creation'
    await createWorktreeThroughHost('creation-1', { ...request(), promptDelivery: 'draft' })
    expect(mocks.draft).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Fix the bug',
        tabId: 'structured-agent-session-claude_created'
      })
    )
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.reveal).not.toHaveBeenCalled()
    expect(mocks.ready).toHaveBeenCalledOnce()
  })

  it('replays the same create after an unanswered call instead of minting another operation', async () => {
    mocks.rpc.mockRejectedValueOnce(
      new RuntimeRpcCallError({
        id: 'create-1',
        ok: false,
        error: {
          code: 'agent_session_operation_unknown',
          message: 'agent_session_operation_unknown'
        }
      })
    )
    const pending = request()
    await expect(createWorktreeThroughHost('creation-1', pending)).rejects.toThrow(
      'Could not confirm whether Claude created the workspace'
    )
    await createWorktreeThroughHost('creation-1', pending)
    expect(mocks.rpc.mock.calls[1]?.[2]).toEqual(mocks.rpc.mock.calls[0]?.[2])
  })
})
