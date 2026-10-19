// Caller-owned placement coverage for launchAgentInNewTab, split from
// launch-agent-in-new-tab.test.ts to keep both files within the lines budget.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { adoptAgentSessionLaunchVerdict } from './agent-session-launch-plan'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

const mockCreateTab = vi.fn()
/** Startup commands published with the created tabs, in creation order. */
function queuedStartups() {
  return mockCreateTab.mock.calls.flatMap((call) => call[3]?.pendingStartup ?? [])
}
const mockSetActiveTabType = vi.fn()
const mockSeedNativeChatAppliedSessionOptions = vi.fn()

type PlacementSettings = {
  agentCmdOverrides: Record<string, string>
  agentDefaultArgs: Record<string, string>
  agentDefaultEnv: Record<string, Record<string, string>>
  activeRuntimeEnvironmentId: string | null
  experimentalNativeChat?: boolean
  nativeChatSessionOptions?: Record<
    string,
    { model?: string; valuesByModel?: Record<string, Record<string, string>> }
  >
}

function placementSettings(overrides: Partial<PlacementSettings> = {}): PlacementSettings {
  return {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: null,
    ...overrides
  }
}

const store = {
  settings: placementSettings(),
  repos: [],
  allWorktrees: vi.fn(() => []),
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  openFiles: [],
  browserTabsByWorktree: {},
  tabBarOrderByWorktree: {},
  createTab: mockCreateTab,
  queueTabInitialCwd: vi.fn(),
  setActiveTabType: mockSetActiveTabType,
  setTabBarOrder: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => store }
}))

vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdFromState: () => null
}))

vi.mock('@/lib/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => true
}))

vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: () => false
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local',
  runtimeEnvironmentIdWithLegacyFallbackUnlessTwin: () => null
}))

vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: (_stored: unknown, terminalIds: string[]) => terminalIds
}))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/components/native-chat/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: mockSeedNativeChatAppliedSessionOptions
}))

vi.mock('@/lib/launch-agent-in-new-tab-structured-route', () => ({
  launchStructuredAgentFromNewTab: () => ({
    surface: { kind: 'host-published' },
    pasteDraftAfterLaunch: false
  })
}))

describe('launchAgentInNewTab terminal tab activation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The local runtime has answered (without structured support), so no launch waits on it.
    setLocalRuntimeCapabilitiesForTests([])
    store.settings = placementSettings()
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
  })

  it('ignores hidden malformed arguments for chat and rejects them before any terminal creation', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const args = { agent: 'codex' as const, worktreeId: 'wt-1', agentArgs: '--model "unfinished' }
    const result = launchAgentInNewTab({
      ...args,
      agentSessionLaunchPlan: adoptAgentSessionLaunchVerdict({
        route: 'structured-native-chat',
        requestId: 'chat',
        agent: 'codex',
        worktreeId: 'wt-1'
      })
    })
    expect(result?.surface.kind).toBe('host-published')
    expect(result?.startupPlan).toBeUndefined()
    expect(launchAgentInNewTab({ ...args, requestId: 'terminal' })).toBeNull()
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  // Why: the store scopes activation to the launch's own workspace, so the floating panel launches
  // like every other caller and cannot move the main window's selection.
  it.each(['wt-1', FLOATING_TERMINAL_WORKTREE_ID])(
    'selects the new tab within %s only',
    async (worktreeId) => {
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

      launchAgentInNewTab({ requestId: 'request-1', agent: 'codex', worktreeId })

      expect(mockCreateTab.mock.calls[0]?.[3]).not.toHaveProperty('activate')
      expect(mockSetActiveTabType).toHaveBeenCalledExactlyOnceWith('terminal', worktreeId)
    }
  )

  it('scopes a floating terminal fallback to the floating workspace with Chat UI on', async () => {
    store.settings = placementSettings({
      experimentalNativeChat: true,
      nativeChatSessionOptions: {
        codex: {
          model: 'gpt-5.2-codex',
          valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } }
        }
      }
    })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'request-2',
      agent: 'codex',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })

    expect(mockCreateTab).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      undefined,
      undefined,
      {
        launchAgent: 'codex',
        quickCommandLabel: undefined,
        pendingStartup: expect.anything()
      }
    )
    expect(mockSetActiveTabType).toHaveBeenCalledExactlyOnceWith(
      'terminal',
      FLOATING_TERMINAL_WORKTREE_ID
    )
    // Chat UI model preferences belong to structured chats, not a terminal fallback.
    expect(queuedStartups()[0]).not.toHaveProperty('sessionOptions')
  })

  it("keeps a terminal action's CLI model and ignores its saved chat options", async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'request-3',
      agent: 'codex',
      worktreeId: 'wt-1',
      agentArgs: '--model old',
      sessionOptions: { model: 'gpt-5.6-terra', effort: 'high' }
    })

    const command = queuedStartups()[0]?.command
    expect(command).toContain("'--model' 'old'")
    expect(command).not.toContain('gpt-5.6-terra')
    expect(queuedStartups()[0]).not.toHaveProperty('sessionOptions')
  })
})
