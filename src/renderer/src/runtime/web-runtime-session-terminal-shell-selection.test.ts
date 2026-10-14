import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TrackingDecisions from './web-session-tabs-sync/tracking-decisions'
import { createWebRuntimeSessionTerminal } from './web-runtime-terminal-creation'
import { peekWebSessionFocusIntent } from './web-session-focus-intent'
import { TERMINAL_CREATE_SHELL_SELECTION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import {
  ENVIRONMENT_ID,
  FOCUS_LEAF_ID,
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

function stubHost(
  status: 'advertised' | 'not-advertised' | 'unreachable',
  { moveFails = false }: { moveFails?: boolean } = {}
) {
  const runtimeCall = vi.fn(async (request: HostRequest) => {
    if (request.method === 'status.get') {
      if (status === 'unreachable') {
        throw new Error('connection lost')
      }
      return {
        id: 'status',
        ok: true,
        result: {
          runtimeId: 'runtime-1',
          graphStatus: 'ready',
          runtimeProtocolVersion: 3,
          minCompatibleRuntimeClientVersion: 2,
          capabilities:
            status === 'advertised' ? [TERMINAL_CREATE_SHELL_SELECTION_RUNTIME_CAPABILITY] : []
        }
      }
    }
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

  it('asks a host that selects shells to run the picked shell itself', async () => {
    const runtimeCall = stubHost('advertised')

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
      expect.objectContaining({
        params: expect.objectContaining({ shell: 'powershell.exe' })
      })
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
    stubHost('advertised', { moveFails: true })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID,
        targetGroupId: 'client-group',
        shell: 'powershell.exe'
      })
    ).resolves.toEqual({ status: 'created' })
  })

  it.each(['not-advertised', 'unreachable'] as const)(
    'keeps typing the shell into the default shell of a host whose support is %s',
    async (status) => {
      const runtimeCall = stubHost(status)

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
    }
  )

  it('does not probe the host for a terminal without a picked shell', async () => {
    const runtimeCall = stubHost('advertised')

    await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      command: 'npm test'
    })

    expect(requestsFor(runtimeCall, 'status.get')).toEqual([])
    expect(requestsFor(runtimeCall, 'session.tabs.createTerminal')).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ command: 'npm test' }) })
    ])
  })
})
