import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import type * as fs from 'node:fs'
import { realpathSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { resolveAppImageRuntimeIdentity } from './appimage-runtime-identity'
import { installAppImageMountExit, MOUNT_KEEPALIVE_SCRIPT } from './appimage-mount-exit'

vi.mock('./appimage-runtime-identity', () => ({
  resolveAppImageRuntimeIdentity: vi.fn()
}))

vi.mock('@orca/process-host', () => ({
  spawnProcess: vi.fn(() => ({ unref: vi.fn() }))
}))

const MOUNT = '/tmp/.mount_Orca-abc123'
const APPIMAGE = '/home/u/orca-linux.AppImage'
const SESSION = '700'
type FakeProc = {
  exe?: string
  session?: string
  fds?: Record<string, [link: string, flags: string]>
}
const RO = '0100000'
const WO = '0100001'
let procs: Record<string, FakeProc> = {}

function defaultProcs(): Record<string, FakeProc> {
  return {
    // An unrelated inherited pipe the server reads from must not be taken for the keepalive.
    self: { session: SESSION, fds: { '3': ['pipe:[111]', RO], '4': ['pipe:[777]', RO] } },
    '40': { exe: `${MOUNT}/chrome_crashpad_handler` },
    '41': { exe: '/tmp/.mount_Orca-zzz999/chrome_crashpad_handler' },
    '42': { exe: `${MOUNT}/orca-ide`, session: SESSION },
    // Detached from main's session, like the mount-fallback daemon and provider supervisors.
    '43': { exe: `${MOUNT}/orca-ide`, session: '900' },
    '44': { exe: '/usr/bin/bash', session: SESSION },
    '50': { exe: APPIMAGE, fds: { '3': ['pipe:[111]', RO], '4': ['pipe:[777]', WO] } }
  }
}

function fail(): never {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
  readdirSync: vi.fn((dir: string) => {
    if (dir === '/proc') {
      return Object.keys(procs)
    }
    const [, , pid] = dir.split('/')
    return Object.keys(procs[pid]?.fds ?? fail())
  }),
  readlinkSync: vi.fn((path: string) => {
    const [, , pid, kind, fd] = path.split('/')
    const proc = procs[pid] ?? fail()
    return (kind === 'exe' ? proc.exe : proc.fds?.[fd]?.[0]) ?? fail()
  }),
  readFileSync: vi.fn((path: string) => {
    const [, , pid, kind, fd] = path.split('/')
    const proc = procs[pid] ?? fail()
    if (kind === 'stat') {
      return `${pid} (orca ide) S 1 1 ${proc.session ?? fail()} 0`
    }
    return `pos:\t0\nflags:\t${proc.fds?.[fd]?.[1] ?? fail()}\n`
  }),
  realpathSync: vi.fn((path: string) => path),
  // Only the FUSE mount root sits on its own device.
  statSync: vi.fn((path: string) => ({ dev: path === MOUNT ? 2 : 1 }))
}))

describe('installAppImageMountExit', () => {
  const originalExecPath = process.execPath

  afterEach(() => {
    process.execPath = originalExecPath
    vi.mocked(spawnProcess).mockClear()
    vi.restoreAllMocks()
  })

  function installExitHook(
    isAppImage: boolean,
    execPath = `${MOUNT}/orca-ide`
  ): (() => void) | undefined {
    procs = defaultProcs()
    process.execPath = execPath
    vi.mocked(resolveAppImageRuntimeIdentity).mockReturnValue(
      isAppImage ? { appImagePath: APPIMAGE } : null
    )
    const once = vi.spyOn(process, 'once').mockReturnValue(process)
    installAppImageMountExit()
    return once.mock.calls.find(([event]) => event === 'exit')?.[1]
  }

  it('SIGKILLs only this launch Crashpad handler', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)

    installExitHook(true)?.()

    expect(kill.mock.calls).toEqual([[40, 'SIGKILL']])
  })

  it("lends the server's write-paired pipe to a watcher of main-session helpers only", () => {
    vi.spyOn(process, 'kill').mockReturnValue(true)

    installExitHook(true)?.()

    const [spec] = vi.mocked(spawnProcess).mock.calls[0]
    expect(spec.args?.slice(4)).toEqual([`42=${MOUNT}/orca-ide`])
    expect(spec.stdio).toEqual(['ignore', 'ignore', 'ignore', 4])
  })

  // Installed deb/rpm handler binaries are shared across launches and must never match.
  it('does not hook exit outside a validated AppImage', () => {
    expect(installExitHook(false)).toBeUndefined()
  })

  it('does not hook exit under extract-and-run, whose dir is shared across launches', () => {
    expect(installExitHook(true, '/tmp/appimage_extracted_0123abcd/orca-ide')).toBeUndefined()
  })
})

describe.runIf(process.platform === 'linux')('MOUNT_KEEPALIVE_SCRIPT', () => {
  const sleepPath = realpathSync('/bin/sleep')

  function runWatcher(ticks: number, helpers: string[]): number {
    const startedAt = Date.now()
    spawnSync('/bin/sh', ['-c', MOUNT_KEEPALIVE_SCRIPT, 'watcher', String(ticks), ...helpers], {
      env: { PATH: '/usr/bin:/bin' }
    })
    return Date.now() - startedAt
  }

  it('waits for a helper, then returns once it exits', () => {
    const helper = nodeSpawn(sleepPath, ['0.5'])
    expect(runWatcher(50, [`${helper.pid}=${sleepPath}`])).toBeGreaterThanOrEqual(400)
  })

  it('releases at the deadline without signalling the helper, and ignores a pid with another exe', () => {
    const helper = nodeSpawn(sleepPath, ['30'])
    try {
      const elapsed = runWatcher(3, [`${helper.pid}=${sleepPath}`, `${process.pid}=${sleepPath}`])
      expect(elapsed).toBeLessThan(5_000)
      expect(process.kill(helper.pid ?? 0, 0)).toBe(true)
      expect(runWatcher(50, [`${process.pid}=${sleepPath}`])).toBeLessThan(1_000)
    } finally {
      helper.kill('SIGKILL')
    }
  })
})
