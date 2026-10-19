import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebRuntimeSessionTerminal } from './web-runtime-terminal-creation'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import {
  WORKTREE_ID,
  resetTerminalCreateEnvironment,
  stubTerminalCreateEnvironment
} from './web-runtime-session-test-harness'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn(),
  setActiveWorktree: vi.fn(),
  createBrowserTab: vi.fn(),
  closeEmptyGroup: vi.fn(),
  moveUnifiedTabToGroup: vi.fn(),
  setRemoteBrowserPageHandle: vi.fn(),
  focusBrowserTabInWorktree: vi.fn(),
  applyWebSessionTabsSnapshot: vi.fn(),
  decideWebSessionTabsSnapshot: vi.fn(() => ({ apply: true, settlesHostMirror: true })),
  getWebSessionTabsTrackingGeneration: vi.fn(() => 0),
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('./web-session-tabs-sync/tracking-lifecycle', () => ({
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot,
  getWebSessionTabsTrackingGeneration: mocks.getWebSessionTabsTrackingGeneration
}))
vi.mock('./web-session-tabs-sync/snapshot-api', () => ({
  applyWebSessionTabsSnapshot: mocks.applyWebSessionTabsSnapshot
}))
vi.mock('./web-session-tabs-sync/tracking-decisions', () => ({
  decideWebSessionTabsSnapshot: mocks.decideWebSessionTabsSnapshot
}))
vi.mock('./web-session-tabs-sync/store-patch', () => ({
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) => {
    mocks.setState(buildPatch)
    // The production caller invokes the returned settle receipt.
    return () => {}
  }
}))
vi.mock('./web-session-tabs-sync/tracking-mappings', () => ({
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))

vi.mock('./web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

afterEach(() => resetWebSessionCloseIntentForTests())

const HOST_REFUSAL = 'Profile state write failed without a confirmed rollback'

describe('a terminal the host fails to create', () => {
  beforeEach(() => {
    stubTerminalCreateEnvironment(mocks)
  })

  afterEach(() => {
    resetTerminalCreateEnvironment()
  })

  it('tells the user why, with a retry, since no tab or pane will ever show it', async () => {
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: false,
        error: { code: 'runtime_error', message: HOST_REFUSAL }
      })
      .mockResolvedValue({
        id: 'create',
        ok: true,
        result: { tab: { id: 'host-tab-2' }, publicationEpoch: 'epoch-1', snapshotVersion: 2 }
      })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(
      createWebRuntimeSessionTerminal({ worktreeId: WORKTREE_ID, activate: true })
    ).resolves.toMatchObject({ status: 'failed' })

    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      'Couldn’t open a new terminal on the host.',
      expect.objectContaining({
        description: expect.stringContaining(HOST_REFUSAL),
        action: expect.objectContaining({ label: 'Try again' })
      })
    )
    const retry = mocks.toastError.mock.calls[0][1].action.onClick as () => void
    retry()
    await vi.waitFor(() =>
      expect(
        runtimeCall.mock.calls.filter(([r]) => r.method === 'session.tabs.createTerminal')
      ).toHaveLength(2)
    )
  })

  it('stays quiet for a caller that reports the failure itself', async () => {
    stubRuntimeEnvironmentBridge({
      call: vi.fn().mockResolvedValue({
        id: 'create',
        ok: false,
        error: { code: 'runtime_error', message: HOST_REFUSAL }
      })
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await createWebRuntimeSessionTerminal(
      { worktreeId: WORKTREE_ID, activate: true },
      { notifyFailure: false }
    )
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('stays quiet when no host session exists, so callers can fall back to a local tab', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    mocks.getState.mockReturnValue({ ...mocks.getState(), settings: {} })
    await expect(
      createWebRuntimeSessionTerminal({ worktreeId: WORKTREE_ID, activate: true })
    ).resolves.toMatchObject({ status: 'failed' })
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})
