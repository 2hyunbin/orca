import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, readFileSyncMock, statSyncMock, switches, appMock } = vi.hoisted(() => {
  const switches = new Map<string, string>()
  return {
    spawnMock: vi.fn(),
    readFileSyncMock: vi.fn(),
    statSyncMock: vi.fn(),
    switches,
    appMock: {
      disableHardwareAcceleration: vi.fn(),
      commandLine: {
        appendSwitch: (name: string, value = '') => {
          switches.set(name, value)
        },
        getSwitchValue: (name: string) => switches.get(name) ?? '',
        removeSwitch: (name: string) => switches.delete(name)
      },
      once: vi.fn()
    }
  }
})

vi.mock('child_process', () => ({ spawn: spawnMock }))
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: readFileSyncMock,
  rmSync: vi.fn(),
  statSync: statSyncMock
}))
vi.mock('electron', () => ({ app: appMock }))

const ENV_KEYS = ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_SESSION_TYPE', 'ELECTRON_OZONE_PLATFORM_HINT']
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
const ORIGINAL_PLATFORM = process.platform
const ORIGINAL_ARGV = process.argv

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

// Electron's pre-main `--ozone-platform-hint=auto` resolution, as observed in #25400.
function resolveElectronOzonePlatform(): void {
  const explicit = process.argv.find((arg) => arg.startsWith('--ozone-platform='))
  if (explicit) {
    switches.set('ozone-platform', explicit.slice('--ozone-platform='.length))
    return
  }
  const hint = process.env.ELECTRON_OZONE_PLATFORM_HINT ?? 'auto'
  const wayland =
    hint === 'wayland' ||
    (hint === 'auto' &&
      (process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY)))
  switches.set('ozone-platform', wayland ? 'wayland' : 'x11')
}

function mockLiveDisplays(): void {
  // DISPLAY=:0 is a live X server; Orca's :99 appears only once Xvfb is spawned.
  let spawned = false
  const isPresent = (path: string): boolean => spawned || !path.includes('99')
  statSyncMock.mockImplementation((path: string) => {
    if (!isPresent(path)) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    return { isSocket: () => true }
  })
  readFileSyncMock.mockImplementation((path: string) => {
    if (!isPresent(path)) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    return '4321\n'
  })
  vi.spyOn(process, 'kill').mockImplementation(() => true)
  spawnMock.mockImplementation(() => {
    spawned = true
    return { pid: 1234, once: vi.fn(), kill: vi.fn(), killed: false }
  })
}

describe('headless serve Ozone platform', () => {
  beforeEach(() => {
    vi.resetModules()
    switches.clear()
    spawnMock.mockReset()
    readFileSyncMock.mockReset()
    statSyncMock.mockReset()
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    process.argv = [...ORIGINAL_ARGV]
  })

  afterEach(async () => {
    const { stopVirtualDisplay } = await import('./ensure-virtual-display')
    process.removeListener('exit', stopVirtualDisplay)
    stopVirtualDisplay()
    vi.restoreAllMocks()
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
    process.argv = ORIGINAL_ARGV
    for (const key of ENV_KEYS) {
      setEnv(key, ORIGINAL_ENV[key])
    }
  })

  const matrix = (['wayland', 'x11', undefined] as const).flatMap((sessionType) =>
    ([':0', undefined] as const).flatMap((display) =>
      (['wayland-0', undefined] as const).map((waylandDisplay) => ({
        sessionType,
        display,
        waylandDisplay
      }))
    )
  )

  it.each(matrix)(
    'runs on X11 with XDG_SESSION_TYPE=$sessionType DISPLAY=$display WAYLAND_DISPLAY=$waylandDisplay',
    async ({ sessionType, display, waylandDisplay }) => {
      setEnv('XDG_SESSION_TYPE', sessionType)
      setEnv('DISPLAY', display)
      setEnv('WAYLAND_DISPLAY', waylandDisplay)
      setEnv('ELECTRON_OZONE_PLATFORM_HINT', undefined)
      mockLiveDisplays()
      resolveElectronOzonePlatform()
      const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

      expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(true)
      expect(appMock.commandLine.getSwitchValue('ozone-platform')).toBe('x11')
      expect(process.env.DISPLAY).toBe(display ?? ':99')
      expect(spawnMock).toHaveBeenCalledTimes(display ? 0 : 1)
    }
  )

  it('overrides an inherited ELECTRON_OZONE_PLATFORM_HINT and argv hint', async () => {
    setEnv('DISPLAY', undefined)
    setEnv('ELECTRON_OZONE_PLATFORM_HINT', 'wayland')
    process.argv = [...ORIGINAL_ARGV, '--ozone-platform-hint=auto']
    mockLiveDisplays()
    resolveElectronOzonePlatform()
    const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

    expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(true)
    expect(appMock.commandLine.getSwitchValue('ozone-platform')).toBe('x11')
  })

  it('leaves an explicit --ozone-platform on argv alone', async () => {
    setEnv('DISPLAY', ':0')
    process.argv = [...ORIGINAL_ARGV, '--ozone-platform=wayland']
    mockLiveDisplays()
    resolveElectronOzonePlatform()
    const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

    ensureVirtualDisplayForHeadlessServe({ isServeMode: true })
    expect(appMock.commandLine.getSwitchValue('ozone-platform')).toBe('wayland')
  })

  it('does not touch the platform outside serve mode', async () => {
    setEnv('XDG_SESSION_TYPE', 'wayland')
    resolveElectronOzonePlatform()
    const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

    ensureVirtualDisplayForHeadlessServe({ isServeMode: false })
    expect(appMock.commandLine.getSwitchValue('ozone-platform')).toBe('wayland')
  })
})
