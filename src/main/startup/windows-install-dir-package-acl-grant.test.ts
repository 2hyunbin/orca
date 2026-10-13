import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resetWindowsSecurityLoadForTests,
  setWindowsSecurityForTests,
  WINDOWS_FILE_READ_EXECUTE,
  type GrantAccessOptions,
  type WindowsSecurityAddon
} from '../../shared/windows-security-addon'
import {
  grantInstallDirPackageAcl,
  RESTRICTED_APP_PACKAGES_SID
} from './windows-install-dir-package-acl-grant'

type GrantCall = {
  path: string
  sid: string
  accessMask: number
  options: GrantAccessOptions
}

function unexpected(): never {
  throw new Error('the package grant must only call grantAccessAsync')
}

/** Installs a fake addon that only allows grantAccessAsync, and returns the grants it saw. */
function installFakeAddon(fail: (path: string) => boolean = () => false): GrantCall[] {
  const calls: GrantCall[] = []
  const addon: WindowsSecurityAddon = {
    currentUserSid: () => 'S-1-5-21-1-2-3-1001',
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
  setWindowsSecurityForTests(addon)
  return calls
}

describe('grantInstallDirPackageAcl', () => {
  let installDir: string

  beforeEach(() => {
    installDir = mkdtempSync(join(tmpdir(), 'orca-acl-grant-'))
    mkdirSync(join(installDir, 'resources', 'app.asar.unpacked'), { recursive: true })
    writeFileSync(join(installDir, 'ffmpeg.dll'), 'binary')
    writeFileSync(join(installDir, 'resources', 'app.asar.unpacked', 'addon.node'), 'binary')
  })

  afterEach(() => {
    resetWindowsSecurityLoadForTests()
    rmSync(installDir, { recursive: true, force: true })
  })

  it('grants the root once, inheritable, so files a later update writes inherit it', async () => {
    const calls = installFakeAddon()
    const outcome = await grantInstallDirPackageAcl(installDir, 'root')
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
    const calls = installFakeAddon()
    const outcome = await grantInstallDirPackageAcl(installDir, 'tree')
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
    const calls = installFakeAddon()
    const grant = grantInstallDirPackageAcl
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
      const calls = installFakeAddon()
      await grantInstallDirPackageAcl(installDir, 'tree')
      const paths = calls.map((call) => call.path)
      expect(paths).not.toContain(join(installDir, 'linked'))
      expect(paths.some((path) => path.includes('elsewhere.dll'))).toBe(false)
    } finally {
      rmSync(join(installDir, 'linked'), { force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('keeps going past failed entries and counts them, like icacls /T /C', async () => {
    const calls = installFakeAddon((path) => path.endsWith('.dll') || path.endsWith('.node'))
    const outcome = await grantInstallDirPackageAcl(installDir, 'tree')
    expect(calls).toHaveLength(5)
    expect(outcome.ok).toBe(false)
    expect(outcome.failedFileCount).toBe(2)
    expect(outcome.reason).toMatch(/^failed-files: .*Win32 error 5/)
  })

  it('counts a failed root grant as one failed entry', async () => {
    installFakeAddon(() => true)
    const outcome = await grantInstallDirPackageAcl(installDir, 'root')
    expect(outcome).toMatchObject({ ok: false, failedFileCount: 1 })
    expect(outcome.reason).toContain('Win32 error 5')
  })

  it('reports an unavailable addon instead of granting anything', async () => {
    setWindowsSecurityForTests(null)
    const grant = grantInstallDirPackageAcl
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

  // The Win32 security APIs fail with error 123 past MAX_PATH; the loader adds the escape once.
  it('reaches a path past MAX_PATH through the extended-length prefix', async () => {
    const calls = installFakeAddon()
    const longDir = `C:\\Program Files\\${'orca'.repeat(70)}`
    await grantInstallDirPackageAcl(longDir, 'root')
    expect(calls.map((call) => call.path)).toEqual([`\\\\?\\${longDir}`])
  })
})
