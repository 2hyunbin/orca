import { describe, expect, it, vi } from 'vitest'
import { recoverDaemonAfterCancelledIdleStop } from './orcad-idle-stop-daemon-recovery'

function ports(options: { admissionClosed?: boolean; liveSessions?: number | null } = {}) {
  return {
    admissionClosed: vi.fn(() => options.admissionClosed ?? false),
    countLiveSessions: vi.fn(async () =>
      options.liveSessions === undefined ? 0 : options.liveSessions
    ),
    replaceDaemon: vi.fn(async () => {}),
    timeoutMs: 20
  }
}

describe('daemon recovery after a cancelled idle stop', () => {
  it('replaces a daemon that retired', async () => {
    const recovery = ports({ admissionClosed: true, liveSessions: null })
    expect(await recoverDaemonAfterCancelledIdleStop({ retirement: 'retired' }, recovery)).toBe(
      'serving'
    )
    expect(recovery.replaceDaemon).toHaveBeenCalledOnce()
    expect(recovery.countLiveSessions).not.toHaveBeenCalled()
  })

  it('replaces a daemon whose retirement landed after the stop timed out', async () => {
    const recovery = ports({ admissionClosed: true, liveSessions: null })
    const outcome = { retirement: 'unverifiable' as const, lateRetirement: Promise.resolve(true) }
    expect(await recoverDaemonAfterCancelledIdleStop(outcome, recovery)).toBe('serving')
    expect(recovery.replaceDaemon).toHaveBeenCalledOnce()
  })

  it('keeps a daemon whose late reply refused retirement and reopened admission', async () => {
    const recovery = ports()
    const outcome = { retirement: 'unverifiable' as const, lateRetirement: Promise.resolve(false) }
    expect(await recoverDaemonAfterCancelledIdleStop(outcome, recovery)).toBe('serving')
    expect(recovery.replaceDaemon).not.toHaveBeenCalled()
  })

  it.each([
    ['live sessions', 2],
    ['an unanswered census', null]
  ])('never replaces a fenced daemon with %s', async (_name, liveSessions) => {
    const recovery = ports({ admissionClosed: true, liveSessions })
    expect(
      await recoverDaemonAfterCancelledIdleStop({ retirement: 'unverifiable' }, recovery)
    ).toBe('unservable')
    expect(recovery.replaceDaemon).not.toHaveBeenCalled()
  })

  it('reports a failed replacement as unservable', async () => {
    const recovery = ports()
    recovery.replaceDaemon.mockRejectedValueOnce(new Error('spawn failed'))
    expect(await recoverDaemonAfterCancelledIdleStop({ retirement: 'retired' }, recovery)).toBe(
      'unservable'
    )
  })
})
