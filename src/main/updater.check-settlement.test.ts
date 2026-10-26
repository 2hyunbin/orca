import type { UpdateStatus } from '../shared/update-status-types'
import { updaterMainWindow } from './updater-test-main-window'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

const {
  autoUpdaterMock,
  fetchChangelogMock,
  fetchNewerReleaseTagsMock,
  closeLocalBuildFeedMock,
  moduleFactories,
  resetUpdaterMocks
} = await vi.hoisted(async () => (await import('./updater-test-harness')).createUpdaterMocks())

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('./ipc/pty/kill-all', () => moduleFactories.ptyKillAll())
vi.mock('./linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('./updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./updater-nudge', () => moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
vi.mock('./local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('./local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())

warmUpdaterModule()

describe('updater', () => {
  beforeEach(() => {
    resetUpdaterMocks()
  })

  it.each(['window', 'webContents', 'absent'] as const)(
    'retains status and settles failures after %s closes',
    async (closedTarget) => {
      const send = vi.fn()
      let destroyed = false
      const window = updaterMainWindow(
        send,
        () => destroyed && closedTarget === 'window',
        () => destroyed
      )
      const {
        setupAutoUpdater,
        getUpdateStatus,
        getRemoteServerUpdaterSnapshot,
        checkForUpdatesFromMenu
      } = await loadUpdaterModule()
      setupAutoUpdater(() => (closedTarget === 'absent' && destroyed ? null : window), {
        getLastUpdateCheckAt: () => Date.now(),
        installMode: 'supervised-headless-serve'
      })
      destroyed = true
      send.mockClear()

      expect(() => autoUpdaterMock.emit('download-progress', { percent: 50 })).not.toThrow()
      expect(getUpdateStatus()).toMatchObject({ state: 'downloading', percent: 50 })
      autoUpdaterMock.checkForUpdates.mockRejectedValue(new Error('network unavailable'))
      checkForUpdatesFromMenu()
      await vi.waitFor(() => {
        expect(getUpdateStatus()).toMatchObject({ state: 'error', message: 'network unavailable' })
      })
      expect(getRemoteServerUpdaterSnapshot('headless-runtime')).toMatchObject({
        runtimeId: 'headless-runtime',
        support: { installMode: 'supervised-headless-serve' },
        status: getUpdateStatus()
      })
      expect(send).not.toHaveBeenCalled()
    }
  )

  it('contains renderer teardown races without losing status', async () => {
    const send = vi.fn(() => {
      throw new Error('Render frame was disposed')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const window = updaterMainWindow(send)
    const updater = await loadUpdaterModule()
    updater.setupAutoUpdater(() => window, { getLastUpdateCheckAt: () => Date.now() })
    try {
      expect(() => autoUpdaterMock.emit('download-progress', { percent: 25 })).not.toThrow()
      expect(updater.getUpdateStatus()).toMatchObject({ state: 'downloading', percent: 25 })
      expect(send).toHaveBeenCalledWith('updater:status', expect.objectContaining({ percent: 25 }))
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it.each(['live', 'closed'] as const)(
    'delivers forced failure before a queued modifier check despite %s delivery',
    async (delivery) => {
      vi.useFakeTimers()
      let settling = false
      const send = vi.fn()
      const window = updaterMainWindow(send, () => settling && delivery === 'closed')
      const { UpdaterSetup } = await import('./updater/updater-setup')
      const failure: UpdateStatus = { state: 'error', message: 'Install preparation failed' }
      class TestUpdater extends UpdaterSetup {
        failInstall(): void {
          this.sendInstallFailureStatus(failure)
        }
      }
      const updater = new TestUpdater()
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        return new Promise(() => {})
      })
      updater.setupAutoUpdater(() => window, { getLastUpdateCheckAt: () => Date.now() })
      updater.checkForUpdatesFromMenu()
      await vi.advanceTimersByTimeAsync(0)
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledOnce()
      updater.checkForUpdatesFromMenu({ includePrerelease: true })
      settling = true
      send.mockClear()
      fetchNewerReleaseTagsMock.mockResolvedValue(['v1.0.52-rc.1'])

      expect(() => updater.failInstall()).not.toThrow()
      expect(updater.getUpdateStatus()).toEqual(failure)
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(0)

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      expect(autoUpdaterMock.allowPrerelease).toBe(true)
      expect(updater.getUpdateStatus()).toMatchObject({ state: 'checking' })
      if (delivery === 'closed') {
        expect(send).not.toHaveBeenCalled()
      } else {
        expect(send).toHaveBeenNthCalledWith(1, 'updater:status', failure)
        expect(send).toHaveBeenNthCalledWith(
          2,
          'updater:status',
          expect.objectContaining({ state: 'checking' })
        )
      }
    }
  )

  it('follows the current window before deferred setup', async () => {
    const oldSend = vi.fn()
    const newSend = vi.fn()
    const oldWindow = updaterMainWindow(oldSend)
    const newWindow = updaterMainWindow(newSend)
    let currentWindow: typeof oldWindow | null = oldWindow
    const getMainWindow = () => currentWindow
    const updater = await loadUpdaterModule()
    const options = { getLastUpdateCheckAt: () => Date.now() }
    updater.setupAutoUpdater(getMainWindow, options)
    currentWindow = null
    updater.setupAutoUpdater(getMainWindow, options)
    autoUpdaterMock.emit('download-progress', { percent: 40 })
    expect(updater.getUpdateStatus()).toMatchObject({ percent: 40 })
    expect(oldSend).not.toHaveBeenCalled()
    currentWindow = newWindow
    const { scheduleMainWindowAutoUpdaterSetup } = await import('./window/main-window-updater')
    Object.assign(newWindow, { once: vi.fn() })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deferred setup is never invoked; this assertion only schedules the successor.
    scheduleMainWindowAutoUpdaterSetup(newWindow, getMainWindow, {} as never)
    autoUpdaterMock.emit('download-progress', { percent: 60 })
    expect(newSend).toHaveBeenCalledWith('updater:status', expect.objectContaining({ percent: 60 }))
    expect(updater.getUpdateStatus()).toMatchObject({ percent: 60 })
    expect(oldSend).not.toHaveBeenCalled()
  })

  it('leaves a dismissed release update on the release source', async () => {
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      autoUpdaterMock.emit('update-available', { version: '2.0.0' })
      return Promise.resolve(undefined)
    })
    const send = vi.fn()
    const { setupAutoUpdater, checkForUpdatesFromMenu, dismissAvailableUpdate } =
      await loadUpdaterModule()
    const mainWindow = updaterMainWindow(send)
    setupAutoUpdater(() => mainWindow, {
      getLastUpdateCheckAt: () => Date.now()
    })

    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({ state: 'available', version: '2.0.0' })
      )
    })

    dismissAvailableUpdate()

    expect(closeLocalBuildFeedMock).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalledWith('updater:status', { state: 'idle' })
  })

  it('deduplicates identical check errors from the event and rejected promise', async () => {
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('boom'))
      })
      return Promise.reject(new Error('boom'))
    })

    const sendMock = vi.fn()
    const mainWindow = updaterMainWindow(sendMock)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(() => mainWindow, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'error', message: 'boom', userInitiated: true })
    })

    const errorStatuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
      .filter((status) => typeof status === 'object' && status !== null && status.state === 'error')

    expect(errorStatuses).toEqual([{ state: 'error', message: 'boom', userInitiated: true }])
  })

  it('surfaces net::ERR_FAILED to user-initiated checks with a friendly message', async () => {
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('net::ERR_FAILED'))
      })
      return Promise.reject(new Error('net::ERR_FAILED'))
    })

    const sendMock = vi.fn()
    const mainWindow = updaterMainWindow(sendMock)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(() => mainWindow, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual(
        expect.objectContaining({
          state: 'error',
          userInitiated: true,
          message: expect.stringContaining("Couldn't reach the update server")
        })
      )
    })

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)

    expect(statuses).toContainEqual({ state: 'checking', userInitiated: true })
    expect(statuses).not.toContainEqual(
      expect.objectContaining({ state: 'error', message: 'net::ERR_FAILED' })
    )
  })

  it('shows checking immediately for a user-initiated check while feed pinning is pending', async () => {
    let resolveTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementation(
      () =>
        new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
          resolveTags = resolve
        })
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return new Promise(() => {})
    })
    const sendMock = vi.fn()
    const mainWindow = updaterMainWindow(sendMock)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(() => mainWindow, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'checking',
      userInitiated: true
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    resolveTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    const checkingStatuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
      .filter(
        (status) => typeof status === 'object' && status !== null && status.state === 'checking'
      )

    expect(checkingStatuses).toEqual([{ state: 'checking', userInitiated: true }])
  })

  it('keeps background checks event-driven before checking-for-update fires', async () => {
    let resolveTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementation(
      () =>
        new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
          resolveTags = resolve
        })
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => new Promise(() => {}))
    const sendMock = vi.fn()
    const mainWindow = updaterMainWindow(sendMock)

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(() => mainWindow, { getLastUpdateCheckAt: () => null })

    expect(
      sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
        .some(
          (status) => typeof status === 'object' && status !== null && status.state === 'checking'
        )
    ).toBe(false)

    resolveTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    autoUpdaterMock.emit('checking-for-update')
    expect(sendMock).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'checking' })
    )
  })

  it('promotes a pending background check to user-initiated without launching a duplicate check', async () => {
    let resolveTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementation(
      () =>
        new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
          resolveTags = resolve
        })
    )
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = updaterMainWindow(sendMock)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(() => mainWindow, { getLastUpdateCheckAt: () => null })
    checkForUpdatesFromMenu()

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'checking',
      userInitiated: true
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    resolveTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    autoUpdaterMock.emit('checking-for-update')
    autoUpdaterMock.emit('update-not-available')
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
  })

  it('keeps a silent background settle user-initiated after menu promotion', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = updaterMainWindow(sendMock)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(() => mainWindow, { getLastUpdateCheckAt: () => null })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(0)

    sendMock.mockClear()
    checkForUpdatesFromMenu()

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'checking',
      userInitiated: true
    })

    await vi.advanceTimersByTimeAsync(1000)

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
  })

  it('settles a manual check when electron-updater resolves without a terminal event', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const setLastUpdateCheckAt = vi.fn()
    const mainWindow = updaterMainWindow(sendMock)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(() => mainWindow, {
      getLastUpdateCheckAt: () => Date.now(),
      setLastUpdateCheckAt
    })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
    expect(setLastUpdateCheckAt).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale update-available event after a silent background settle', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = updaterMainWindow(sendMock)

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(() => mainWindow, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt: vi.fn()
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    autoUpdaterMock.emit('update-available', { version: '1.0.61' })
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchChangelogMock).not.toHaveBeenCalled()
    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'available', version: '1.0.61' })
    )
  })

  it('ignores a stale checking-for-update event after a silent manual settle', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = updaterMainWindow(sendMock)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(() => mainWindow, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    sendMock.mockClear()
    autoUpdaterMock.emit('checking-for-update')

    expect(sendMock).not.toHaveBeenCalled()
  })
})
