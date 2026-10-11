// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NewerDaemonHold } from '../../../../../shared/newer-daemon-hold'
import { reopenHeldTerminals, resetNewerDaemonHoldStateForTests } from '../newer-daemon-hold-state'
import { holdForNewerDaemon } from './newer-daemon-hold-pane'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

let readNewerDaemonHold: ReturnType<typeof vi.fn<(sessionId: string) => Promise<NewerDaemonHold>>>

function makeSession(overrides: Record<string, unknown> = {}): ConnectPanePtySession {
  const transport = {}
  const pane = { id: 1, terminal: { options: { disableStdin: false } } }
  const session = {
    pane,
    transport,
    cacheKey: 'tab:leaf',
    disposed: false,
    transportStreamGeneration: 1,
    runtimeEnvironmentId: null,
    waitTeardowns: new Array<() => void>(),
    writeReplayData: vi.fn(),
    buildColdRestoreAgentResumeStartup: vi.fn(() => ({ command: 'claude --resume x' })),
    deps: { paneTransportsRef: { current: new Map([[1, transport]]) } },
    ...overrides
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hold reads only the fields stubbed above.
  return session as unknown as ConnectPanePtySession
}

beforeEach(() => {
  resetNewerDaemonHoldStateForTests()
  readNewerDaemonHold = vi.fn(() => Promise.resolve<NewerDaemonHold>({ held: false }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      pty: {
        readNewerDaemonHold,
        reopenNewerDaemonTerminals: vi.fn(() => Promise.resolve({ reopened: true }))
      }
    }
  })
})

afterEach(() => resetNewerDaemonHoldStateForTests())

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('holdForNewerDaemon', () => {
  it('shows the saved screen read-only and spawns nothing until released', async () => {
    readNewerDaemonHold.mockResolvedValue({
      held: true,
      restoredScreen: { scrollback: 'saved screen', cols: 80, rows: 24 }
    })
    const session = makeSession()
    const connect = vi.fn((onSettled: (o: { reopened: boolean; agentResumed: boolean }) => void) =>
      onSettled({ reopened: true, agentResumed: true })
    )
    holdForNewerDaemon(session, 's1', connect)
    await flush()
    expect(session.pane.terminal.options.disableStdin).toBe(true)
    expect(session.writeReplayData).toHaveBeenCalledWith('saved screen')
    expect(connect).not.toHaveBeenCalled()

    await reopenHeldTerminals()
    expect(connect).toHaveBeenCalledTimes(1)
    expect(session.pane.terminal.options.disableStdin).toBe(false)
    expect(session.writeReplayData).toHaveBeenLastCalledWith('\x1b[0m\x1b[2J\x1b[3J\x1b[H')
  })

  it('reconnects at once when the hold was released before the screen read', async () => {
    readNewerDaemonHold.mockResolvedValue({ held: false })
    const session = makeSession()
    const connect = vi.fn()
    holdForNewerDaemon(session, 's1', connect)
    await flush()
    expect(connect).toHaveBeenCalledTimes(1)
    expect(session.pane.terminal.options.disableStdin).toBe(false)
  })

  it('does not paint or release a pane superseded while reading', async () => {
    const session = makeSession()
    readNewerDaemonHold.mockImplementation(async () => {
      session.disposed = true
      return { held: true, restoredScreen: { scrollback: 'late', cols: 80, rows: 24 } }
    })
    const connect = vi.fn()
    holdForNewerDaemon(session, 's1', connect)
    await flush()
    expect(session.writeReplayData).not.toHaveBeenCalled()
    await reopenHeldTerminals()
    expect(connect).not.toHaveBeenCalled()
  })

  it('does not release a pane that unmounted while held', async () => {
    readNewerDaemonHold.mockResolvedValue({ held: true, restoredScreen: null })
    const session = makeSession()
    const connect = vi.fn()
    holdForNewerDaemon(session, 's1', connect)
    await flush()
    for (const teardown of session.waitTeardowns) {
      teardown()
    }
    await reopenHeldTerminals()
    expect(connect).not.toHaveBeenCalled()
  })
})
