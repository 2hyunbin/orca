import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../../shared/plugins/plugin-viewer-document-test-fixture'
import {
  PLUGIN_VIEWER_HEARTBEAT_DEADLINE_MS,
  PLUGIN_VIEWER_HEARTBEAT_INTERVAL_MS,
  hasExclusivePluginViewerProcess,
  startPluginViewerGuestWatchdog
} from './plugin-viewer-guest-watchdog'

function fixture() {
  const events = new EventEmitter()
  const pending = deferred<unknown>()
  const guest = {
    id: 1,
    isDestroyed: vi.fn(() => false),
    getOSProcessId: vi.fn(() => 321),
    executeJavaScriptInIsolatedWorld: vi.fn(() => pending.promise),
    forcefullyCrashRenderer: vi.fn(),
    once: events.once.bind(events),
    removeListener: events.removeListener.bind(events)
  }
  const host = {
    id: 2,
    isDestroyed: () => false,
    getOSProcessId: vi.fn(() => 654)
  }
  const onUnavailable = vi.fn()
  const options = { getPeerContents: () => [host, guest], onUnavailable }
  return { guest, host, pending, events, options, onUnavailable }
}

afterEach(() => vi.useRealTimers())

describe('isolated viewer watchdog', () => {
  it('refuses admission when the guest has no PID or shares any live peer process', () => {
    const setup = fixture()
    setup.guest.getOSProcessId.mockReturnValue(0)
    expect(hasExclusivePluginViewerProcess(setup.guest, setup.options.getPeerContents())).toBe(
      false
    )
    setup.guest.getOSProcessId.mockReturnValue(321)
    setup.host.getOSProcessId.mockReturnValue(321)
    expect(() => startPluginViewerGuestWatchdog(setup.guest, setup.options)).toThrow(
      'plugin_viewer_shared_process'
    )
    expect(setup.guest.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })

  it('crashes only an exclusively owned stalled renderer after the deadline', async () => {
    vi.useFakeTimers()
    const setup = fixture()
    startPluginViewerGuestWatchdog(setup.guest, setup.options)
    await vi.advanceTimersByTimeAsync(PLUGIN_VIEWER_HEARTBEAT_DEADLINE_MS - 1)
    expect(setup.guest.forcefullyCrashRenderer).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(setup.guest.forcefullyCrashRenderer).toHaveBeenCalledTimes(1)
    expect(setup.onUnavailable).toHaveBeenCalledWith('unresponsive')
    setup.pending.resolve(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(setup.guest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1)
  })

  it.each(['shared', 'changed'] as const)(
    'rechecks %s PID at the kill boundary',
    async (change) => {
      vi.useFakeTimers()
      const setup = fixture()
      startPluginViewerGuestWatchdog(setup.guest, setup.options)
      if (change === 'shared') {
        setup.host.getOSProcessId.mockReturnValue(321)
      } else {
        setup.guest.getOSProcessId.mockReturnValue(987)
      }
      await vi.advanceTimersByTimeAsync(PLUGIN_VIEWER_HEARTBEAT_DEADLINE_MS)
      expect(setup.guest.forcefullyCrashRenderer).not.toHaveBeenCalled()
      expect(setup.onUnavailable).toHaveBeenCalledWith(
        change === 'shared' ? 'shared_process' : 'renderer_changed'
      )
    }
  )

  it('uses a trusted isolated literal and never stacks outstanding pings', async () => {
    vi.useFakeTimers()
    const setup = fixture()
    const watchdog = startPluginViewerGuestWatchdog(setup.guest, setup.options)
    await vi.advanceTimersByTimeAsync(0)
    expect(setup.guest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(1002, [
      { code: 'true' }
    ])
    setup.pending.resolve(true)
    await vi.advanceTimersByTimeAsync(PLUGIN_VIEWER_HEARTBEAT_INTERVAL_MS)
    expect(setup.guest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2)
    watchdog.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(setup.guest.forcefullyCrashRenderer).not.toHaveBeenCalled()
    expect(setup.events.listenerCount('destroyed')).toBe(0)
    expect(setup.events.listenerCount('render-process-gone')).toBe(0)
  })

  it('refuses a forced crash if child-frame ownership changed at the kill boundary', async () => {
    vi.useFakeTimers()
    const setup = fixture()
    let authorized = true
    startPluginViewerGuestWatchdog(setup.guest, {
      ...setup.options,
      isAuthorized: () => authorized
    })
    authorized = false
    await vi.advanceTimersByTimeAsync(PLUGIN_VIEWER_HEARTBEAT_DEADLINE_MS)
    expect(setup.guest.forcefullyCrashRenderer).not.toHaveBeenCalled()
    expect(setup.onUnavailable).toHaveBeenCalledExactlyOnceWith('shared_process')
  })
  it('withdraws a stalled viewer without forcing a crash when peer ownership is uncertain', async () => {
    vi.useFakeTimers()
    const setup = fixture()
    startPluginViewerGuestWatchdog(setup.guest, { ...setup.options, canCrash: () => false })
    await vi.advanceTimersByTimeAsync(PLUGIN_VIEWER_HEARTBEAT_DEADLINE_MS)
    expect(setup.guest.forcefullyCrashRenderer).not.toHaveBeenCalled()
    expect(setup.onUnavailable).toHaveBeenCalledExactlyOnceWith('shared_process')
  })

  it('cleans up timers and listeners when the guest renderer disappears', async () => {
    vi.useFakeTimers()
    const setup = fixture()
    startPluginViewerGuestWatchdog(setup.guest, setup.options)
    setup.events.emit('render-process-gone')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(setup.guest.forcefullyCrashRenderer).not.toHaveBeenCalled()
    expect(setup.onUnavailable).not.toHaveBeenCalled()
    expect(setup.events.listenerCount('destroyed')).toBe(0)
  })
  it('handles a native heartbeat failure without letting it escape the main event loop', async () => {
    vi.useFakeTimers()
    const setup = fixture()
    setup.guest.executeJavaScriptInIsolatedWorld.mockImplementationOnce(() => {
      throw new Error('guest unavailable')
    })
    startPluginViewerGuestWatchdog(setup.guest, setup.options)
    await vi.advanceTimersByTimeAsync(0)
    expect(setup.onUnavailable).toHaveBeenCalledWith('renderer_changed')
    await vi.advanceTimersByTimeAsync(PLUGIN_VIEWER_HEARTBEAT_DEADLINE_MS)
    expect(setup.guest.forcefullyCrashRenderer).not.toHaveBeenCalled()
  })
})
