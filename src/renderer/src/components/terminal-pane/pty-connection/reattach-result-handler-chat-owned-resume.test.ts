import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindHandleReattachResult } from './reattach-result-handler'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import type { ReattachPayloadContext } from './reattach-payload-context'

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = { tabsByWorktree: {}, terminalLayoutsByTabId: {} }
  const capturedContexts: ReattachPayloadContext[] = []
  return { state, capturedContexts }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep: vi.fn() }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('../terminal-freeze-breadcrumbs', () => ({ recordTerminalFreezeBreadcrumb: vi.fn() }))
vi.mock('./apply-reattach-payload', () => ({
  createReattachPayloadHandlers: (_session: unknown, ctx: ReattachPayloadContext) => {
    mocks.capturedContexts.push(ctx)
    return { applyReattachPayload: async () => {}, fitAfterReattachRestore: async () => {} }
  }
}))

const CHAT_OWNED_PLAN: ColdRestoreAgentResumeStartup = {
  command: "claude --resume 'chat-session'",
  agent: 'claude',
  resumeProviderSession: { key: 'session_id', id: 'chat-session' },
  launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
  launchToken: 'launch-token-1',
  useLiveEntry: true,
  hasSleepingRecord: false,
  sleepingRecordEntry: null
}

function localSession(): ConnectPanePtySession {
  const transport = { getPtyId: () => 'pty-1', disconnect: vi.fn(), serializeBuffer: vi.fn() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a deliberately partial session bag; an unexpected member access fails the test.
  const session = {
    transport,
    disposed: false,
    transportStreamGeneration: 0,
    authoritativeReattachGeneration: 0,
    mountFollowsTerminalPark: false,
    cacheKey: 'cache-1',
    pane: { id: 'pane-1', leafId: 'leaf-1', terminal: { options: { scrollback: 1000 } } },
    deps: {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      paneTransportsRef: { current: new Map([['pane-1', transport]]) },
      isVisibleRef: { current: true },
      clearTabPtyId: vi.fn(),
      updateTabPtyId: vi.fn(),
      restoredLeafId: null
    },
    agentCompletionCoordinator: { startProcessTracking: vi.fn() },
    structuralReplayCoordinator: { run: vi.fn(async (task: () => Promise<void>) => task()) },
    retireChatOwnedColdRestore: vi.fn(() => null),
    showSessionRestoredBanner: vi.fn(),
    registerEffectiveLaunchConfig: vi.fn(),
    startFreshColdRestoreAgentResume: vi.fn(),
    setPanePtyFitBinding: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn(),
    clearExitedPanePtyLayoutBinding: vi.fn(),
    reportPanePtyVisibility: vi.fn(),
    registerSideEffectFactConsumerForPty: vi.fn(),
    syncHiddenRendererPtyDelivery: vi.fn(),
    registerPaneSerializerFor: vi.fn(),
    sampleVisiblePaneForegroundAgent: vi.fn(),
    scheduleReattachIdleAgentCursorReset: vi.fn(),
    settlePaneAttachAttempt: vi.fn()
  } as unknown as ConnectPanePtySession
  bindHandleReattachResult(session)
  return session
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.capturedContexts = []
})

describe('handleReattachResult with a resume a native chat owns', () => {
  // A dead daemon session with no restorable history comes back as a fresh shell, no scrollback.
  const FRESH_REFUSED = { id: 'pty-1', agentResumeUnavailable: true, agentResumeOwnedByChat: true }

  it('retires the plan, says so, and registers no agent for the plain shell', async () => {
    const session = localSession()

    await session.handleReattachResult(FRESH_REFUSED, null, CHAT_OWNED_PLAN)

    expect(session.retireChatOwnedColdRestore).toHaveBeenCalledExactlyOnceWith(CHAT_OWNED_PLAN)
    expect(session.showSessionRestoredBanner).toHaveBeenCalledExactlyOnceWith('resume-unavailable')
    expect(session.registerEffectiveLaunchConfig).toHaveBeenCalledWith(undefined, {})
    expect(mocks.capturedContexts[0]?.coldRestoreStartup).toBeNull()
  })

  it('leaves an unowned resume plan to the pane', async () => {
    const session = localSession()

    await session.handleReattachResult({ id: 'pty-1' }, null, CHAT_OWNED_PLAN)

    expect(session.retireChatOwnedColdRestore).not.toHaveBeenCalled()
    expect(session.showSessionRestoredBanner).not.toHaveBeenCalled()
    expect(session.registerEffectiveLaunchConfig).toHaveBeenCalledWith(undefined, {
      launchToken: 'launch-token-1',
      launchAgent: 'claude'
    })
  })
})
