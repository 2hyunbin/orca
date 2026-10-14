import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TrackingDecisions from './web-session-tabs-sync/tracking-decisions'
import { createWebRuntimeSessionTerminal } from './web-runtime-terminal-creation'
import { peekWebSessionFocusIntent } from './web-session-focus-intent'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import {
  ENVIRONMENT_ID,
  FOCUS_LEAF_ID,
  RUNTIME_EXECUTION_HOST_ID,
  WORKTREE_ID,
  makeSnapshot,
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
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn()
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
vi.mock('./web-session-tabs-sync/tracking-decisions', async (importOriginal) => ({
  ...(await importOriginal<typeof TrackingDecisions>()),
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

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))

vi.mock('./web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
}))

afterEach(() => resetWebSessionCloseIntentForTests())

const HOST_TAB_ID = 'host-shell-tab'

type HostRequest = { method: string; params?: Record<string, unknown> }

/** The paired host's workspace row, as worktree.detectedList delivered it. */
function seedHostWorktree(windowsTerminalShells: string[] | undefined): void {
  const state = mocks.getState()
  mocks.getState.mockReturnValue({
    ...state,
    worktreesByRepo: {
      'host-repo': [
        {
          id: WORKTREE_ID,
          repoId: 'host-repo',
          hostId: RUNTIME_EXECUTION_HOST_ID,
          path: '/worktree',
          ...(windowsTerminalShells ? { windowsTerminalShells } : {})
        }
      ]
    }
  })
}

function stubHost({ moveFails = false }: { moveFails?: boolean } = {}) {
  const runtimeCall = vi.fn(async (request: HostRequest) => {
    if (request.method === 'terminal.create') {
      return {
        id: 'create',
        ok: true,
        result: {
          terminal: {
            handle: 'term-shell',
            worktreeId: WORKTREE_ID,
            title: null,
            tabId: HOST_TAB_ID,
            paneKey: `${HOST_TAB_ID}:${FOCUS_LEAF_ID}`
          }
        }
      }
    }
    if (request.method === 'session.tabs.createTerminal') {
      return {
        id: 'legacy-create',
        ok: true,
        result: { tab: { id: HOST_TAB_ID, leafId: FOCUS_LEAF_ID } }
      }
    }
    if (request.method === 'session.tabs.move') {
      if (moveFails) {
        throw new Error('connection lost')
      }
      return { id: 'move', ok: true, result: { moved: true } }
    }
    return { id: 'list', ok: true, result: makeSnapshot() }
  })
  stubRuntimeEnvironmentBridge({ call: runtimeCall })
  return runtimeCall
}

function requestsFor(runtimeCall: ReturnType<typeof stubHost>, method: string) {
  return runtimeCall.mock.calls
    .map(([request]) => request)
    .filter((request) => request.method === method)
}

describe('creating a terminal with a picked shell on a paired host', () => {
  beforeEach(() => {
    stubTerminalCreateEnvironment(mocks)
  })

  afterEach(() => {
    resetTerminalCreateEnvironment()
  })

  it('asks the host to run a shell it listed for the workspace', async () => {
    seedHostWorktree(['powershell.exe', 'cmd.exe', 'git-bash'])
    const runtimeCall = stubHost()

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID,
        targetGroupId: 'client-group',
        shell: 'powershell.exe',
        activate: true
      })
    ).resolves.toEqual({ status: 'created' })

    expect(requestsFor(runtimeCall, 'terminal.create')).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ shell: 'powershell.exe' }) })
    ])
    const createParams = requestsFor(runtimeCall, 'terminal.create')[0]?.params
    expect(createParams).not.toHaveProperty('command')
    // A background create would stay out of a window-hosted server's own tab strip.
    expect(createParams).not.toHaveProperty('presentation')
    expect(requestsFor(runtimeCall, 'session.tabs.createTerminal')).toEqual([])
    expect(requestsFor(runtimeCall, 'session.tabs.move')).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          tabId: HOST_TAB_ID,
          targetGroupId: 'client-group',
          kind: 'move-to-group'
        })
      })
    ])
    expect(peekWebSessionFocusIntent({ environmentId: ENVIRONMENT_ID }, WORKTREE_ID)).toEqual({
      hostTabId: HOST_TAB_ID,
      leafId: FOCUS_LEAF_ID
    })
  })

  it('reports a shell terminal the host made as created even when the group move fails', async () => {
    // Why: a "failed" answer invites a retry, which would start a second terminal on the host.
    seedHostWorktree(['powershell.exe'])
    stubHost({ moveFails: true })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID,
        targetGroupId: 'client-group',
        shell: 'powershell.exe'
      })
    ).resolves.toEqual({ status: 'created' })
  })

  it.each([
    { name: 'sends no shell list (an older host)', shells: undefined },
    { name: 'did not list the shell', shells: ['wsl.exe'] }
  ])('types the shell into the default shell of a host that $name', async ({ shells }) => {
    seedHostWorktree(shells)
    const runtimeCall = stubHost()

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID,
        targetGroupId: 'client-group',
        shell: 'cmd.exe',
        activate: true
      })
    ).resolves.toEqual({ status: 'created' })

    expect(requestsFor(runtimeCall, 'terminal.create')).toEqual([])
    expect(requestsFor(runtimeCall, 'session.tabs.createTerminal')).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ command: 'cmd.exe', targetGroupId: 'client-group' })
      })
    ])
  })

  it('keeps a terminal without a picked shell on the session-tab create', async () => {
    seedHostWorktree(['powershell.exe'])
    const runtimeCall = stubHost()

    await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      command: 'npm test'
    })

    expect(requestsFor(runtimeCall, 'terminal.create')).toEqual([])
    expect(requestsFor(runtimeCall, 'session.tabs.createTerminal')).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ command: 'npm test' }) })
    ])
  })
})
