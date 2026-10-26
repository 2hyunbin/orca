import type * as fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAppImageRuntimeIdentity } from './appimage-runtime-identity'
import { spawnProcess } from '@orca/process-host'
import { installAppImageMountExit } from './appimage-mount-exit'

vi.mock('./appimage-runtime-identity', () => ({
  resolveAppImageRuntimeIdentity: vi.fn()
}))

vi.mock('@orca/process-host', () => ({
  spawnProcess: vi.fn(() => ({ unref: vi.fn() }))
}))

const MOUNT = '/tmp/.mount_Orca-abc123'
const APPIMAGE = '/home/u/orca-linux.AppImage'
const KEEPALIVE = 'pipe:[777]'
const PROC_LINKS: Record<string, string> = {
  '/proc/40/exe': `${MOUNT}/chrome_crashpad_handler`,
  '/proc/41/exe': `${MOUNT}/chrome_crashpad_handler`,
  '/proc/42/exe': `${MOUNT}/orca-ide`,
  '/proc/43/exe': '/tmp/.mount_Orca-zzz999/chrome_crashpad_handler',
  '/proc/44/exe': '/chrome_crashpad_handler',
  // A sibling launch of the same AppImage runs its own FUSE server and keepalive pipe.
  '/proc/50/exe': APPIMAGE,
  '/proc/50/fd/4': 'pipe:[555]',
  // Our server outlives an in-place update that replaced the AppImage file.
  '/proc/51/exe': `${APPIMAGE} (deleted)`,
  '/proc/51/fd/3': APPIMAGE,
  '/proc/51/fd/4': KEEPALIVE,
  '/proc/60/exe': '/usr/bin/bash',
  '/proc/self/fd/3': KEEPALIVE,
  '/proc/self/fd/9': 'pipe:[888]'
}
let procPids = ['40', '41', '42', '43', '44', '45', '50', '51', '60', 'self']

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
  readdirSync: vi.fn((dir: string) =>
    dir === '/proc'
      ? procPids
      : Object.keys(PROC_LINKS)
          .filter((link) => link.startsWith(`${dir}/`))
          .map((link) => link.slice(dir.length + 1))
  ),
  readlinkSync: vi.fn((path: string) => {
    const link = PROC_LINKS[path]
    if (!link) {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    }
    return link
  }),
  realpathSync: vi.fn((path: string) => path),
  // Only the FUSE mount root sits on its own device.
  statSync: vi.fn((path: string) => ({ dev: path === MOUNT ? 2 : 1 }))
}))

describe('installAppImageMountExit', () => {
  const originalExecPath = process.execPath

  afterEach(() => {
    process.execPath = originalExecPath
    procPids = ['40', '41', '42', '43', '44', '45', '50', '51', '60', 'self']
    vi.mocked(spawnProcess).mockClear()
    vi.restoreAllMocks()
  })

  function installExitHook(
    isAppImage: boolean,
    execPath = `${MOUNT}/orca-ide`
  ): (() => void) | undefined {
    process.execPath = execPath
    vi.mocked(resolveAppImageRuntimeIdentity).mockReturnValue(
      isAppImage ? { appImagePath: APPIMAGE } : null
    )
    const once = vi.spyOn(process, 'once').mockReturnValue(process)
    installAppImageMountExit()
    return once.mock.calls.find(([event]) => event === 'exit')?.[1]
  }

  it('SIGKILLs only this launch handler, surviving one that already exited', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 40) {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      }
      return true
    })

    installExitHook(true)?.()

    expect(kill.mock.calls).toEqual([
      [40, 'SIGKILL'],
      [41, 'SIGKILL']
    ])
  })

  it('lends only our keepalive pipe to a watcher of only our on-mount helpers', () => {
    vi.spyOn(process, 'kill').mockReturnValue(true)

    installExitHook(true)?.()

    expect(spawnProcess).toHaveBeenCalledTimes(1)
    const [spec] = vi.mocked(spawnProcess).mock.calls[0]
    expect(spec.args?.slice(3)).toEqual([`42=${MOUNT}/orca-ide`])
    expect(spec.stdio).toEqual(['ignore', 'ignore', 'ignore', 3])
  })

  it('does not start a watcher when no helper is left on the mount', () => {
    vi.spyOn(process, 'kill').mockReturnValue(true)
    procPids = procPids.filter((pid) => pid !== '42')

    installExitHook(true)?.()

    expect(spawnProcess).not.toHaveBeenCalled()
  })

  // Installed deb/rpm handler binaries are shared across launches and must never match.
  it('does not hook exit outside a validated AppImage', () => {
    expect(installExitHook(false)).toBeUndefined()
  })

  it('does not hook exit under extract-and-run, whose dir is shared across launches', () => {
    expect(installExitHook(true, '/tmp/appimage_extracted_0123abcd/orca-ide')).toBeUndefined()
  })
})
