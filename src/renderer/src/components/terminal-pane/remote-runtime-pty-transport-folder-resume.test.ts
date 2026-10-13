import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'
const { runtimeCall, refreshSessionTabsSnapshot, resetRemoteRuntimeTransport } =
  createRemoteRuntimeTransportMocks({
    getCallbacks: () => subscriptionCallbacks,
    setCallbacks: (callbacks) => {
      subscriptionCallbacks = callbacks
    },
    getResolvedPaneHandle: () => resolvedPaneHandle,
    setResolvedPaneHandle: (handle) => {
      resolvedPaneHandle = handle
    }
  })

beforeEach(() => resetRemoteRuntimeTransport())
afterEach(() => vi.unstubAllGlobals())

it('silently resumes a project-owned folder in the same pane after a pre-claim refusal', async () => {
  const defaultCall = runtimeCall.getMockImplementation()
  runtimeCall.mockImplementation(async (args: { method: string }) => {
    if (args.method === 'status.get') {
      return {
        ok: true,
        result: {
          runtimeProtocolVersion: 3,
          minCompatibleRuntimeClientVersion: 2,
          capabilities: ['agent-session.host-authority.v1']
        }
      }
    }
    if (args.method === 'terminal.ensureAgentSession') {
      return {
        ok: false,
        error: {
          code: 'agent_session_legacy_required',
          message: 'agent_session_legacy_required'
        }
      }
    }
    return defaultCall?.(args)
  })
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const onPtySpawn = vi.fn()
  const onError = vi.fn()
  const providerSession = { key: 'session_id', id: 'resume-session' } as const
  const command = 'claude "--resume" "resume-session"'
  const transport = createRemoteRuntimePtyTransport('local', {
    worktreeId: 'folder:fw-1',
    tabId: 'resume-tab',
    leafId: 'resume-leaf',
    launchAgent: 'claude',
    resumeProviderSession: providerSession,
    command,
    onPtySpawn
  })
  try {
    await expect(transport.connect({ url: '', callbacks: { onError } })).resolves.toEqual({
      id: 'remote:local@@terminal-1',
      replay: ''
    })
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'local',
        method: 'terminal.ensureAgentSession',
        params: expect.objectContaining({
          placement: { tabId: 'resume-tab', leafId: 'resume-leaf' }
        })
      })
    )
    const creates = runtimeCall.mock.calls.filter(([args]) => args.method === 'terminal.create')
    expect(creates).toHaveLength(1)
    expect(creates[0]?.[0]).toMatchObject({
      selector: 'local',
      method: 'terminal.create',
      params: {
        worktree: 'id:folder:fw-1',
        tabId: 'resume-tab',
        leafId: 'resume-leaf',
        command,
        launchAgent: 'claude',
        resumeProviderSession: providerSession,
        presentation: 'background',
        focus: false
      }
    })
    expect(onPtySpawn).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    expect(refreshSessionTabsSnapshot).not.toHaveBeenCalled()
  } finally {
    transport.destroy?.()
  }
})
