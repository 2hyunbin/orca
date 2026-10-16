import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/runtime/structured-agent-session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/runtime/structured-agent-session-client')>()),
  callStructuredAgentSession: vi.fn(async () => ({ supported: false }))
}))

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(),
  closeTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  setActiveTabType: vi.fn(),
  toastInfo: vi.fn()
}))

const store = {
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings: {
    agentCmdOverrides: {} as Record<string, string>,
    agentDefaultArgs: {} as Record<string, string>,
    agentDefaultEnv: {} as Record<string, Record<string, string>>,
    activeRuntimeEnvironmentId: 'web-runtime' as string | null
  },
  projects: [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'inherit-global' as const } }],
  repos: [{ id: 'repo-1', connectionId: null, path: '/repo' }],
  worktreesByRepo: {
    'repo-1': [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        projectId: 'repo-1',
        path: '/repo/worktree',
        displayName: 'main'
      }
    ]
  },
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] as { id: string; launchAgent?: string }[] },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  terminalLayoutsByTabId: {},
  ptyIdsByTabId: {},
  sshConnectionStates: new Map(),
  sshStateByEnvironment: new Map(),
  runtimeStatusByEnvironmentId: new Map([['web-runtime', { status: { hostPlatform: 'linux' } }]]),
  transientClearedAgentStatusConnectionIds: {},
  allWorktrees: vi.fn(() => store.worktreesByRepo['repo-1']),
  createTab: mocks.createTab,
  closeTab: mocks.closeTab,
  queueTabStartupCommand: vi.fn(),
  setActiveTabType: mocks.setActiveTabType,
  setTabBarOrder: vi.fn(),
  setAgentStatus: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  markNativeChatLaunchPromptFailed: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn(), info: mocks.toastInfo } }))
vi.mock('@/components/tab-bar/reconcile-order', () => ({ reconcileTabOrder: vi.fn(() => []) }))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/runtime/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: mocks.createWebRuntimeSessionTerminal
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: vi.fn(() => true)
}))
vi.mock('../../../shared/terminal-surface-id', () => ({
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))

describe('launchAgentInNewTab paired web runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: 'web-runtime'
    }
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({ status: 'created' })
  })

  it('delegates agent quick launch to the host runtime', async () => {
    store.tabsByWorktree['wt-1'].push({ id: 'local-agent-tab', launchAgent: 'claude' })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-1',
      agent: 'claude',
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toEqual(
      expect.objectContaining({
        surface: { kind: 'host-published' },
        pasteDraftAfterLaunch: false
      })
    )
    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith(
      {
        worktreeId: 'wt-1',
        environmentId: 'web-runtime',
        targetGroupId: 'group-1',
        activate: true,
        agentSessionKind: 'fresh',
        agent: 'claude',
        viewMode: 'terminal'
      },
      { notifyFailure: false }
    )
    expect(mocks.createTab).not.toHaveBeenCalled()
    await Promise.resolve()
    // Why: host creation is async, so the user may be viewing another worktree by the time it lands.
    expect(mocks.setActiveTabType).toHaveBeenCalledExactlyOnceWith('terminal', 'wt-1')
    // A local tab closes locally (the host close no-ops), so a launch leaves it alone.
    expect(mocks.closeTab).not.toHaveBeenCalled()
  })

  it('forwards prompt launch env and captured config to the host runtime', async () => {
    store.settings.agentDefaultArgs = { codex: '--model gpt-5 --reasoning-effort high' }
    store.settings.agentDefaultEnv = { codex: { CODEX_PROFILE: 'captured' } }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-2',
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'fix the spinner',
      groupId: 'group-1'
    })

    expect(result).toEqual(
      expect.objectContaining({
        surface: { kind: 'host-published' },
        pasteDraftAfterLaunch: false
      })
    )
    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith(
      {
        worktreeId: 'wt-1',
        environmentId: 'web-runtime',
        targetGroupId: 'group-1',
        activate: true,
        agentSessionKind: 'fresh',
        launchAgent: 'codex',
        command: "codex '--model' 'gpt-5' '--reasoning-effort' 'high' 'fix the spinner'",
        env: { CODEX_PROFILE: 'captured' },
        launchConfig: {
          agentCommand: "codex '--model' 'gpt-5' '--reasoning-effort' 'high'",
          agentArgs: '--model gpt-5 --reasoning-effort high',
          agentEnv: { CODEX_PROFILE: 'captured' }
        },
        startupCommandDelivery: 'shell-ready',
        prompt: 'fix the spinner',
        promptDelivery: 'auto-submit',
        viewMode: 'terminal'
      },
      { notifyFailure: false }
    )
    expect(mocks.createTab).not.toHaveBeenCalled()
  })

  it.each(['created', 'failed'] as const)(
    'settles declined new-tab launch after %s receipt',
    async (status) => {
      const { adoptAgentSessionLaunchVerdict } = await import('./agent-session-launch-plan')
      const { launchStructuredAgentFromNewTab } = await import(
        './launch-agent-in-new-tab-structured-route'
      )
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
      let finish!: (outcome: { status: string; message: string }) => void
      mocks.createWebRuntimeSessionTerminal.mockReturnValue(
        new Promise((resolve) => (finish = resolve))
      )
      const result = launchStructuredAgentFromNewTab({
        plan: adoptAgentSessionLaunchVerdict({
          requestId: 'declined-receipt',
          route: 'structured-native-chat',
          agent: 'claude',
          executionHostId: 'runtime:web-runtime',
          worktreeId: 'wt-1'
        }),
        worktreeId: 'wt-1',
        openTerminal: (agentSessionLaunchPlan) =>
          launchAgentInNewTab({ agent: 'claude', worktreeId: 'wt-1', agentSessionLaunchPlan })
      })
      await vi.waitFor(() => expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledOnce())
      expect(mocks.toastInfo).not.toHaveBeenCalled()
      finish({ status, message: 'Could not create terminal' })
      await expect(result?.structuredSettlement).resolves.toEqual(
        status === 'created' ? { kind: 'terminal' } : { kind: 'cancelled', sessionId: null }
      )
      expect(mocks.toastInfo).toHaveBeenCalledTimes(status === 'created' ? 1 : 0)
    }
  )
})
