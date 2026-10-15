import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { quit: vi.fn() } }))
vi.mock('../updater', () => ({ checkForUpdatesFromMenu: vi.fn(), isQuittingForUpdate: vi.fn() }))
vi.mock('../tray/system-tray', () => ({
  createSystemTray: vi.fn(),
  setMacMenuBarIconVisible: vi.fn()
}))
vi.mock('../window/attach-main-window-services', () => ({ ensureAutoUpdaterConfigured: vi.fn() }))
vi.mock('../window/focus-existing-window', () => ({
  focusExistingMainWindow: vi.fn(),
  safelyRevealWindow: vi.fn()
}))
vi.mock('../window/dashboard-popout-window', () => ({ getDashboardPopoutWindow: () => null }))
vi.mock('../window/createMainWindow', () => ({ loadMainWindow: vi.fn() }))
vi.mock('./windows-install-dir-acl-recovery', () => ({
  describeInstallDirAclPoison: vi.fn(),
  isBlockingInstallDirAclRepairInFlight: vi.fn()
}))
vi.mock('../window/renderer-recovery-prompt', () => ({ presentRendererRecoveryPrompt: vi.fn() }))
vi.mock('../window/renderer-launch-failure-probe', () => ({ probeRendererLaunchCapacity: vi.fn() }))

import { createSystemTrayDeferred } from './main-window-actions'
import { mainProcessState as state } from './main-process-state'
import { createSystemTray, setMacMenuBarIconVisible } from '../tray/system-tray'

const originalPlatform = process.platform
const isDestroyed = vi.fn(() => false)
const onCreated = vi.fn()
const settings = { showMenuBarIcon: true }

function startupTrayCallback(): () => void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: startup tray creation only reads isDestroyed from the window.
  const window = { isDestroyed } as unknown as Electron.BrowserWindow
  return createSystemTrayDeferred(window, onCreated)
}

describe('startup tray scene scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    isDestroyed.mockReturnValue(false)
    settings.showMenuBarIcon = true
    Object.assign(state, {
      isQuitting: false,
      isServeMode: false,
      store: { getSettings: () => settings },
      devInstanceIdentity: null
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the startup callback only checks whether a tray was returned.
    const tray = {} as Electron.Tray
    vi.mocked(createSystemTray).mockReturnValue(tray)
    vi.mocked(setMacMenuBarIconVisible).mockImplementation((visible) => (visible ? tray : null))
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    state.store = null
    state.isQuitting = false
    state.isServeMode = false
  })

  it('defers macOS creation past the caller and promise microtasks', async () => {
    const createTray = startupTrayCallback()
    createTray()
    await Promise.resolve()

    expect(setMacMenuBarIconVisible).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)

    expect(setMacMenuBarIconVisible).toHaveBeenCalledOnce()
    expect(onCreated).toHaveBeenCalledOnce()
  })

  it('creates only once when first paint and the fallback both request a tray', () => {
    const createTray = startupTrayCallback()
    createTray()
    createTray()
    vi.advanceTimersByTime(0)
    createTray()
    vi.advanceTimersByTime(0)

    expect(setMacMenuBarIconVisible).toHaveBeenCalledOnce()
    expect(onCreated).toHaveBeenCalledOnce()
  })

  it.each(['closed', 'quitting', 'store-unavailable', 'serve'] as const)(
    'does not create a tray if startup becomes %s before the timer runs',
    (reason) => {
      startupTrayCallback()()
      if (reason === 'closed') {
        isDestroyed.mockReturnValue(true)
      }
      if (reason === 'quitting') {
        state.isQuitting = true
      }
      if (reason === 'store-unavailable') {
        state.store = null
      }
      if (reason === 'serve') {
        state.isServeMode = true
      }
      vi.advanceTimersByTime(0)

      expect(setMacMenuBarIconVisible).not.toHaveBeenCalled()
      expect(createSystemTray).not.toHaveBeenCalled()
      expect(onCreated).not.toHaveBeenCalled()
    }
  )

  it('honors the current visibility preference when the deferred callback runs', () => {
    startupTrayCallback()()
    settings.showMenuBarIcon = false
    vi.advanceTimersByTime(0)

    expect(setMacMenuBarIconVisible).toHaveBeenCalledWith(false, expect.any(Object))
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('allows a later attempt if the store was unavailable at the first timer', () => {
    const store = state.store
    const createTray = startupTrayCallback()
    createTray()
    state.store = null
    vi.advanceTimersByTime(0)
    state.store = store
    createTray()
    vi.advanceTimersByTime(0)

    expect(setMacMenuBarIconVisible).toHaveBeenCalledOnce()
    expect(onCreated).toHaveBeenCalledOnce()
  })

  it.each(['win32', 'linux'] as const)(
    'preserves synchronous startup callback behavior on %s',
    (platform) => {
      Object.defineProperty(process, 'platform', { value: platform })
      const createTray = startupTrayCallback()
      createTray()

      expect(createSystemTray).toHaveBeenCalledOnce()
      expect(setMacMenuBarIconVisible).not.toHaveBeenCalled()
      expect(onCreated).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      createTray()
      expect(createSystemTray).toHaveBeenCalledOnce()
    }
  )
})
