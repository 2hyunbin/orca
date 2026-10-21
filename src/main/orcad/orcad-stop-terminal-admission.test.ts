// Once orcad begins to stop, a terminal it admits dies with it uncounted, so admission stays closed
// until exit: past an update census's 60 s fence, and past a deferring desktop's reopen.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalUpdateAdmission } from '../runtime/terminal/stop/terminal-update-admission'
import { installOrcadShutdownSignals } from './orcad-lifecycle'
import { prepareOrcadManagedStop } from './orcad-managed-stop-admission'
import { bindOrcadStopTerminalAdmission } from './orcad-stop-terminal-admission'

let now = 1_000
let admission = new TerminalUpdateAdmission(
  async () => [],
  () => now
)

function freshAdmission(): TerminalUpdateAdmission {
  now = 1_000
  admission = new TerminalUpdateAdmission(
    async () => [],
    () => now
  )
  bindOrcadStopTerminalAdmission(admission)
  return admission
}

/** An update's last census closed admission; then the desktop deferred and reopened it, or lapsed. */
function expectHeldPastEveryReopen(): void {
  admission.close(0)
  expect(admission.isClosed()).toBe(true)
  admission.close(60_000)
  now += 61_000
  expect(admission.isClosed()).toBe(true)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('orcad stop terminal admission', () => {
  it('closes admission when a managed stop begins, before anything else it prepares', async () => {
    freshAdmission()
    let closedFirst = false
    await prepareOrcadManagedStop(
      {
        schemaVersion: 1,
        transactionId: 't',
        version: '1.0.0',
        runtimeId: 'r',
        instance: { pid: 1, startedAtMs: null, nonce: 'n', lockPath: '/tmp/orcad.lock' }
      },
      async () => ({ retirement: 'retired', liveSessions: 0, reason: null }),
      () => {
        closedFirst = admission.isClosed()
      }
    )

    expect(closedFirst).toBe(true)
    expectHeldPastEveryReopen()
  })

  it('closes admission when any shutdown begins, before the runtime stops', () => {
    vi.useFakeTimers()
    vi.spyOn(process, 'on').mockImplementation(() => process)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    freshAdmission()
    let closedAtStop = false
    const shutdown = installOrcadShutdownSignals(async () => {
      closedAtStop = admission.isClosed()
      return new Promise<void>(() => {})
    })

    expect(shutdown('idle')).toBe(true)
    expect(closedAtStop).toBe(true)
    expectHeldPastEveryReopen()
  })
})
