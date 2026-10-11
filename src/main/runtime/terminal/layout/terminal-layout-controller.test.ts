import { describe, expect, it, vi } from 'vitest'
import { TerminalLayoutController } from './terminal-layout-controller'
import type { TerminalLayoutHost } from './terminal-layout-context'

function createHost(overrides: Partial<TerminalLayoutHost> = {}): TerminalLayoutHost {
  return {
    getStore: () => null,
    getNotifier: () => null,
    getPtyController: () => null,
    getTerminalSize: () => ({ cols: 120, rows: 40 }),
    resizeHeadlessTerminal: () => {},
    notifyRemoteTerminalViewPresenceChanged: () => {},
    isUnattachedLocalCandidate: () => false,
    ...overrides
  }
}

describe('TerminalLayoutController ownership', () => {
  it('keeps floors, subscribers, queued layouts and listeners isolated for identical IDs', async () => {
    const first = new TerminalLayoutController(createHost()).commands
    const second = new TerminalLayoutController(createHost()).commands
    const secondResize = vi.fn()
    second.subscribeToTerminalResize('pty', secondResize)

    await first.handleMobileSubscribe('pty', 'client', { cols: 50, rows: 25 })

    expect(first.getDriver('pty')).toEqual({ kind: 'mobile', clientId: 'client' })
    expect(first.getLayout('pty')).toMatchObject({ kind: 'phone', cols: 50, rows: 25 })
    expect(second.getDriver('pty')).toEqual({ kind: 'idle' })
    expect(second.isMobileSubscriberActive('pty')).toBe(false)
    expect(second.getLayout('pty')).toBeNull()
    expect(second.getTerminalFitOverride('pty')).toBeNull()
    expect(secondResize).not.toHaveBeenCalled()

    await second.handleMobileSubscribe('pty', 'client', { cols: 60, rows: 30 })
    first.clearPtyMobilePresence('pty')
    first.retirePtyLayoutQueue('pty')
    first.releaseExitedPtyFitOverride('pty')
    first.clearExitedPtyFloors('pty')

    expect(second.isMobileSubscriberActive('pty')).toBe(true)
    expect(second.getDriver('pty')).toEqual({ kind: 'mobile', clientId: 'client' })
    expect(second.getTerminalFitOverride('pty')).toMatchObject({ cols: 60, rows: 30 })
    expect(secondResize).toHaveBeenCalledOnce()
  })

  it('uses providers and notifiers installed after construction, before publishing resize events', async () => {
    let provider: ReturnType<TerminalLayoutHost['getPtyController']> = null
    let notifier: ReturnType<TerminalLayoutHost['getNotifier']> = null
    let size = { cols: 120, rows: 40 }
    const events: string[] = []
    const commands = new TerminalLayoutController(
      createHost({
        getPtyController: () => provider,
        getNotifier: () => notifier,
        getTerminalSize: () => size,
        resizeHeadlessTerminal: (_ptyId, cols, rows) => {
          size = { cols, rows }
        }
      })
    ).commands
    commands.subscribeToTerminalResize('pty', (event) => events.push(`wire:${event.seq}`))

    provider = { resize: () => (events.push('provider:first'), true) }
    notifier = {
      terminalDriverChanged: () => events.push('driver:first'),
      terminalFitOverrideChanged: () => events.push('fit:first')
    }
    await commands.handleMobileSubscribe('pty', 'client', { cols: 50, rows: 25 })
    expect(events).toEqual(['driver:first', 'provider:first', 'fit:first', 'wire:1'])

    events.length = 0
    provider = { resize: () => (events.push('provider:second'), true) }
    notifier = {
      terminalDriverChanged: () => events.push('driver:second'),
      terminalFitOverrideChanged: () => events.push('fit:second')
    }
    await commands.reclaimTerminalForDesktop('pty')
    expect(events).toEqual(['provider:second', 'fit:second', 'wire:2', 'driver:second'])
    expect(commands.getTerminalFitOverride('pty')).toBeNull()
  })
})
