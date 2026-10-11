// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAgentStatusStartupSnapshot } from '@/hooks/ipc-events/agent-status-startup-snapshot'
import { NEWER_DAEMON_HOLD_ERROR } from '../../../../../shared/newer-daemon-hold'
import { reopenHeldTerminals, resetNewerDaemonHoldStateForTests } from '../newer-daemon-hold-state'
import { startDeferredSessionReattach } from './deferred-session-reattach-connect'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('../terminal-lifecycle-diagnostics', () => ({ warnTerminalLifecycleAnomaly: vi.fn() }))
vi.mock('./pty-connect-limits', () => ({
  recordPtyConnectDiagnostic: vi.fn(),
  isSshSessionGoneError: () => false
}))

function createSession() {
  let onError: (message: string) => void = () => {}
  let holdNextConnect = true
  const transport = {
    connect: vi.fn(async () => {
      if (holdNextConnect) {
        onError(`Error invoking remote method 'pty:spawn': Error: ${NEWER_DAEMON_HOLD_ERROR}`)
        return undefined
      }
      return { id: 'restored-pty', coldRestore: { scrollback: 'x', cwd: '/', cols: 80, rows: 24 } }
    }),
    getPtyId: () => null
  }
  const fixture = {
    pane: { id: 1, terminal: { options: { disableStdin: false } } },
    transport,
    disposed: false,
    transportStreamGeneration: 1,
    waitTeardowns: new Array<() => void>(),
    deps: { paneTransportsRef: { current: new Map([[1, transport]]) } },
    buildColdRestoreAgentResumeStartup: () => ({ command: 'claude --resume c1', agent: 'claude' }),
    captureTransportOutputCallbacks: (reportError: (message: string) => void) => {
      onError = reportError
      return { generation: 1, callbacks: {} }
    },
    beginReattachLiveDataDeferral: vi.fn(),
    finishReattachLiveDataDeferral: vi.fn(),
    shouldDeclareHiddenAtSpawn: () => false,
    mergeStartupEnvWithPaneIdentity: (env: Record<string, string>) => env,
    handleReattachResult: vi.fn().mockResolvedValue(true),
    startFreshColdRestoreAgentResume: vi.fn(),
    writeReplayData: vi.fn(),
    reportError: vi.fn(),
    cols: 80,
    rows: 24,
    cacheKey: 'tab:leaf'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture provides every session field read by deferred reattach and the hold.
  const session = fixture as unknown as ConnectPanePtySession
  return { fixture, session, transport, release: () => (holdNextConnect = false) }
}

describe('restored pane refused for a newer daemon', () => {
  let bridge: ReturnType<typeof registerAgentStatusStartupSnapshot>
  beforeEach(() => {
    resetNewerDaemonHoldStateForTests()
    bridge = registerAgentStatusStartupSnapshot()
    bridge.settle()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        pty: {
          declarePendingPaneSerializer: vi.fn().mockResolvedValue(null),
          readNewerDaemonHold: vi.fn().mockResolvedValue({ held: true, restoredScreen: null }),
          reopenNewerDaemonTerminals: vi.fn().mockResolvedValue({ reopened: true })
        }
      }
    })
  })
  afterEach(() => {
    bridge.dispose()
    resetNewerDaemonHoldStateForTests()
  })

  it('holds the pane instead of reporting an error or starting a fresh agent', async () => {
    const { fixture, session, transport } = createSession()
    startDeferredSessionReattach(session, 'restored-pty')
    await vi.waitFor(() => expect(fixture.pane.terminal.options.disableStdin).toBe(true))
    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(fixture.reportError).not.toHaveBeenCalled()
    expect(fixture.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
    expect(fixture.handleReattachResult).not.toHaveBeenCalled()
  })

  it('reconnects the same session through the normal path once released', async () => {
    const { fixture, session, transport, release } = createSession()
    startDeferredSessionReattach(session, 'restored-pty')
    await vi.waitFor(() => expect(fixture.pane.terminal.options.disableStdin).toBe(true))
    release()
    await reopenHeldTerminals()
    expect(transport.connect).toHaveBeenCalledTimes(2)
    expect(transport.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'restored-pty', command: 'claude --resume c1' })
    )
    expect(fixture.handleReattachResult).toHaveBeenCalledTimes(1)
    expect(fixture.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
  })
})
