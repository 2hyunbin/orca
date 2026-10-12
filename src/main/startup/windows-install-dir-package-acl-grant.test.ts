import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  WINDOWS_FILE_READ_EXECUTE,
  type WindowsSecurityAddon,
  type WindowsSecurityGrantOptions
} from '../../shared/windows-security-addon'
import {
  nativeInstallDirPackageGrant,
  RESTRICTED_APP_PACKAGES_SID
} from './windows-install-dir-package-acl-grant'

type GrantCall = {
  path: string
  sid: string
  accessMask: number
  options: WindowsSecurityGrantOptions
}

function unexpected(): never {
  throw new Error('the package grant must only call grantAccessAsync')
}

function fakeAddon(fail: (path: string) => boolean = () => false): {
  addon: WindowsSecurityAddon
  calls: GrantCall[]
} {
  const calls: GrantCall[] = []
  const addon: WindowsSecurityAddon = {
    currentUserSid: unexpected,
    getDaclSddl: unexpected,
    setDaclSddl: unexpected,
    setDaclSddlAsync: unexpected,
    createFileWithDacl: unexpected,
    grantAccess: unexpected,
    grantAccessAsync: async (path, sid, accessMask, options) => {
      calls.push({ path, sid, accessMask, options })
      if (fail(path)) {
        throw new Error('SetNamedSecurityInfoW failed with Win32 error 5')
      }
    }
  }
  return { addon, calls }
}

describe('nativeInstallDirPackageGrant', () => {
  let installDir: string

  beforeEach(() => {
    installDir = mkdtempSync(join(tmpdir(), 'orca-acl-grant-'))
    mkdirSync(join(installDir, 'resources', 'app.asar.unpacked'), { recursive: true })
    writeFileSync(join(installDir, 'ffmpeg.dll'), 'binary')
    writeFileSync(join(installDir, 'resources', 'app.asar.unpacked', 'addon.node'), 'binary')
  })

  afterEach(() => {
    rmSync(installDir, { recursive: true, force: true })
  })

  it('grants the root once, inheritable, so files a later update writes inherit it', async () => {
    const { addon, calls } = fakeAddon()
    const outcome = await nativeInstallDirPackageGrant(addon)(installDir, 'root')
    expect(outcome).toEqual({ ok: true, failedFileCount: 0 })
    expect(calls).toEqual([
      {
        path: installDir,
        sid: RESTRICTED_APP_PACKAGES_SID,
        accessMask: WINDOWS_FILE_READ_EXECUTE,
        options: { inheritable: true, replace: false }
      }
    ])
  })

  it('grants every entry flagless on the tree pass, the root and nested files included', async () => {
    const { addon, calls } = fakeAddon()
    const outcome = await nativeInstallDirPackageGrant(addon)(installDir, 'tree')
    expect(outcome).toEqual({ ok: true, failedFileCount: 0 })
    expect(calls.map((call) => call.path).sort()).toEqual(
      [
        installDir,
        join(installDir, 'ffmpeg.dll'),
        join(installDir, 'resources'),
        join(installDir, 'resources', 'app.asar.unpacked'),
        join(installDir, 'resources', 'app.asar.unpacked', 'addon.node')
      ].sort()
    )
    for (const call of calls) {
      expect(call.sid).toBe(RESTRICTED_APP_PACKAGES_SID)
      expect(call.accessMask).toBe(WINDOWS_FILE_READ_EXECUTE)
      expect(call.options).toEqual({ inheritable: false, replace: false })
    }
  })

  it('never replaces existing rules on either pass', async () => {
    const { addon, calls } = fakeAddon()
    const grant = nativeInstallDirPackageGrant(addon)
    await grant(installDir, 'root')
    await grant(installDir, 'tree')
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.every((call) => call.options.replace === false)).toBe(true)
  })

  it('does not follow a link out of the install tree', async (context) => {
    const outside = mkdtempSync(join(tmpdir(), 'orca-acl-grant-outside-'))
    writeFileSync(join(outside, 'elsewhere.dll'), 'binary')
    try {
      symlinkSync(outside, join(installDir, 'linked'), 'junction')
    } catch {
      rmSync(outside, { recursive: true, force: true })
      context.skip()
      return
    }
    try {
      const { addon, calls } = fakeAddon()
      await nativeInstallDirPackageGrant(addon)(installDir, 'tree')
      const paths = calls.map((call) => call.path)
      expect(paths).not.toContain(join(installDir, 'linked'))
      expect(paths.some((path) => path.includes('elsewhere.dll'))).toBe(false)
    } finally {
      rmSync(join(installDir, 'linked'), { force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('keeps going past failed entries and counts them, like icacls /T /C', async () => {
    const { addon, calls } = fakeAddon((path) => path.endsWith('.dll') || path.endsWith('.node'))
    const outcome = await nativeInstallDirPackageGrant(addon)(installDir, 'tree')
    expect(calls).toHaveLength(5)
    expect(outcome.ok).toBe(false)
    expect(outcome.failedFileCount).toBe(2)
    expect(outcome.reason).toMatch(/^failed-files: .*Win32 error 5/)
  })

  it('counts a failed root grant as one failed entry', async () => {
    const { addon } = fakeAddon(() => true)
    const outcome = await nativeInstallDirPackageGrant(addon)(installDir, 'root')
    expect(outcome).toMatchObject({ ok: false, failedFileCount: 1 })
    expect(outcome.reason).toContain('Win32 error 5')
  })

  it('reports an unavailable addon instead of granting anything', async () => {
    const grant = nativeInstallDirPackageGrant(null)
    expect(await grant(installDir, 'root')).toEqual({
      ok: false,
      failedFileCount: 0,
      reason: 'addon-unavailable'
    })
    expect(await grant(installDir, 'tree')).toEqual({
      ok: false,
      failedFileCount: 0,
      reason: 'addon-unavailable'
    })
  })
})
