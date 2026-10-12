import { join } from 'node:path'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  probeWindowsInstallDirAcl,
  resetWindowsInstallDirAclProbeForTest,
  WINDOWS_INSTALL_DIR_ACL_BREADCRUMB,
  type WindowsInstallDirAclProbeOptions
} from './windows-install-dir-acl-probe'
import { isInstallDirAclPoisonVerdict } from './windows-install-dir-package-acl-repair'
import {
  ALL_PACKAGES_ACE,
  fakeDaclReader,
  ORPHAN_PACKAGE_ACE,
  RESTRICTED_PACKAGES_ACE
} from './windows-install-dir-acl.test-fixture'

const INSTALL_DIR = 'C:\\Users\\neil\\AppData\\Local\\Programs\\orca'
const ORPHAN = ORPHAN_PACKAGE_ACE
const RESTRICTED_GRANT = RESTRICTED_PACKAGES_ACE

const fakeReader = fakeDaclReader

function probe(options: WindowsInstallDirAclProbeOptions): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    probeWindowsInstallDirAcl({
      platform: 'win32',
      installDir: INSTALL_DIR,
      fileExists: (path) => path.endsWith('ffmpeg.dll'),
      ...options,
      recordBreadcrumb: (name, data) => {
        resolve({ ...(data as Record<string, unknown>), name })
        return undefined
      }
    })
  })
}

/** Every target returns the same ACE set on top of the system baseline. */
function probeWith(...aces: string[]): Promise<Record<string, unknown>> {
  return probe({ readDaclSddl: fakeReader(() => aces).readDaclSddl })
}

describe('probeWindowsInstallDirAcl', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
  })

  it('reports a clean DACL as unpoisoned', async () => {
    const data = await probe({
      readDaclSddl: fakeReader(() => []).readDaclSddl
    })
    expect(data.name).toBe(WINDOWS_INSTALL_DIR_ACL_BREADCRUMB)
    expect(data.status).toBe('ok')
    expect(data.orphanPackageSidCount).toBe(0)
    expect(data.matchesPoisonSignature).toBe(false)
  })

  it('flags an orphan package SID with no well-known grant', async () => {
    const data = await probeWith(ORPHAN)
    expect(data.matchesPoisonSignature).toBe(true)
    expect(data.orphanPackageSidCount).toBe(1)
    expect(data.orphanPackageSids).toBe('S-1-15-2-999-999-999')
    expect(data.hasWellKnownPackageGrant).toBe(false)
  })

  it('clears the signature once the restricted package ACE grants access', async () => {
    const data = await probeWith(RESTRICTED_GRANT, ORPHAN)
    expect(data.hasWellKnownPackageGrant).toBe(true)
    expect(data.hasRestrictedPackageGrant).toBe(true)
    expect(data.orphanPackageSidCount).toBe(1)
    expect(data.matchesPoisonSignature).toBe(false)
  })

  // A Program Files install inherits ALL APPLICATION PACKAGES by default, and an
  // orphan alongside it launched clean on win32 10.0.26200 / Electron 43.4.1 — so
  // it is not the reproduced state, however useless -1 is to an LPAC token.
  it.each([
    ['the AC alias', ALL_PACKAGES_ACE],
    ['the raw SID form', '(A;OICI;0x1200a9;;;S-1-15-2-1)']
  ])('clears the signature when only ALL APPLICATION PACKAGES grants (%s)', async (_l, ace) => {
    const data = await probeWith(ace, ORPHAN)
    expect(data.hasWellKnownPackageGrant).toBe(true)
    expect(data.hasRestrictedPackageGrant).toBe(false)
    expect(data.matchesPoisonSignature).toBe(false)
  })

  // The reproduced remedy was an additive *grant*; an ACE that grants nothing on
  // the object cannot satisfy the orphan, so it must not clear the signature.
  it.each([
    ['deny', '(D;OICI;FA;;;AC)'],
    ['inherit-only', '(A;OICIIO;GRGX;;;AC)'],
    ['restricted deny', '(D;;FA;;;S-1-15-2-2)'],
    ['restricted inherit-only', '(A;CIOIIO;GRGX;;;S-1-15-2-2)']
  ])('does not let a %s well-known ACE satisfy an orphan', async (_label, ace) => {
    const data = await probeWith(ace, ORPHAN)
    expect(data.hasWellKnownPackageGrant).toBe(false)
    expect(data.hasRestrictedPackageGrant).toBe(false)
    expect(data.matchesPoisonSignature).toBe(true)
  })

  it('does not let a grant on one target mask its absence on another', async () => {
    const data = await probe({
      readDaclSddl: fakeReader((target) =>
        target.endsWith('ffmpeg.dll') ? [ORPHAN] : [RESTRICTED_GRANT, ORPHAN]
      ).readDaclSddl
    })
    expect(data.hasWellKnownPackageGrant).toBe(true)
    expect(data.matchesPoisonSignature).toBe(true)
  })

  // Display listings localize package names (zh/ja/ko); SDDL never does, so a repaired
  // tree must read clean whatever the UI language.
  it('reads a repaired tree as clean from SIDs alone', async () => {
    let verdict: CrashReportBreadcrumbData = {}
    const data = await probe({
      readDaclSddl: fakeReader(() => [ORPHAN, RESTRICTED_GRANT]).readDaclSddl,
      onDone: (done) => (verdict = done)
    })
    expect(isInstallDirAclPoisonVerdict(verdict)).toBe(false)
    expect(data.status).toBe('ok')
    expect(data.orphanPackageSidCount).toBe(1)
    expect(data.hasRestrictedPackageGrant).toBe(true)
  })

  it('matches the well-known SIDs exactly, not by prefix', async () => {
    const data = await probeWith('(A;OICI;0x1200a9;;;S-1-15-2-1234567890)')
    expect(data.orphanPackageSidCount).toBe(1)
    expect(data.hasWellKnownPackageGrant).toBe(false)
    expect(data.matchesPoisonSignature).toBe(true)
  })

  it('ignores capability SIDs, which are a different family and harmless', async () => {
    const data = await probeWith('(A;;0x100020;;;S-1-15-3-65536-599108337-2355189375-1353122160)')
    expect(data.orphanPackageSidCount).toBe(0)
    expect(data.matchesPoisonSignature).toBe(false)
  })

  it('probes a content file, not just the directory object', async () => {
    const fake = fakeReader(() => [ORPHAN])
    await probe({ readDaclSddl: fake.readDaclSddl })
    expect(fake.calls).toEqual([INSTALL_DIR, join(INSTALL_DIR, 'ffmpeg.dll')])
  })

  // Real DACLs captured on win32 10.0.26200 (the SDDL `icacls /save` also wrote).
  it.each([
    [
      'a repaired module file',
      'ffmpeg.dll\r\nD:AI(A;;0x1200a9;;;S-1-15-2-2)(A;;0x1200a9;;;S-1-15-2-999-999-999)' +
        '(A;ID;0x1200a9;;;S-1-15-2-999-999-999)(A;ID;FA;;;SY)(A;ID;FA;;;BA)' +
        '(A;ID;FA;;;S-1-5-21-432636774-4279371817-3971399515-1001)\r\n',
      false
    ],
    [
      'a poisoned dir whose AC ACE denies',
      'scan21acl\r\nD:AI(D;;0x100116;;;AC)(A;OICI;0x1200a9;;;S-1-15-2-999-999-999)' +
        '(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)' +
        '(A;OICIID;FA;;;S-1-5-21-432636774-4279371817-3971399515-1001)\r\n',
      true
    ]
  ])('reads a real captured DACL: %s', async (_label, saved, poisoned) => {
    const data = await probe({
      fileExists: () => false,
      readDaclSddl: fakeReader(() => saved).readDaclSddl
    })
    expect(data.orphanPackageSids).toBe('S-1-15-2-999-999-999')
    expect(data.matchesPoisonSignature).toBe(poisoned)
  })

  it('keeps a conditional DACL unreadable instead of hiding a later package grant', async () => {
    const saved =
      'orca\r\nD:AI(A;OICI;0x1200a9;;;S-1-15-2-999-999-999)' +
      '(XA;OICI;FA;;;WD;(@User.Department == "Finance"))' +
      '(A;OICIID;0x1200a9;;;S-1-15-2-2)\r\n'
    let verdict: CrashReportBreadcrumbData = {}
    const data = await probe({
      fileExists: () => false,
      readDaclSddl: fakeReader(() => saved).readDaclSddl,
      onDone: (done) => (verdict = done)
    })
    expect(data).toMatchObject({ status: 'failed', reason: 'all-targets-unreadable' })
    expect(data.matchesPoisonSignature).toBeUndefined()
    expect(isInstallDirAclPoisonVerdict(verdict)).toBe(false)
  })

  it('treats a read that fails as unreadable, never as a clean DACL', async () => {
    let verdict: CrashReportBreadcrumbData = {}
    const data = await probe({
      fileExists: () => false,
      readDaclSddl: fakeReader(() => null).readDaclSddl,
      onDone: (done) => (verdict = done)
    })
    expect(data).toMatchObject({ status: 'failed', reason: 'all-targets-unreadable' })
    expect(isInstallDirAclPoisonVerdict(verdict)).toBe(false)
  })

  it('does not report malformed saved output as a clean DACL', async () => {
    const data = await probe({
      fileExists: () => false,
      readDaclSddl: fakeReader(() => 'orca').readDaclSddl
    })
    expect(data).toMatchObject({ status: 'failed', reason: 'all-targets-unreadable' })
    expect(data.matchesPoisonSignature).toBeUndefined()
  })

  it('records a failure instead of throwing when no DACL can be read', async () => {
    const data = await probe({ readDaclSddl: fakeReader(() => null).readDaclSddl })
    expect(data.status).toBe('failed')
    expect(data.reason).toBe('all-targets-unreadable')
    expect(data.matchesPoisonSignature).toBeUndefined()
  })

  it.each([
    ['darwin', { platform: 'darwin' as NodeJS.Platform }],
    ['serve mode', { platform: 'win32' as NodeJS.Platform, isServeMode: true }]
  ])('does no work on %s', async (_label, options) => {
    const fake = fakeReader(() => [ORPHAN])
    const record = vi.fn()
    const fileExists = vi.fn(() => true)
    probeWindowsInstallDirAcl({
      installDir: INSTALL_DIR,
      readDaclSddl: fake.readDaclSddl,
      fileExists,
      recordBreadcrumb: record,
      ...options
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(fake.calls).toHaveLength(0)
    expect(fileExists).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })

  it('runs once per process', async () => {
    const fake = fakeReader(() => [ORPHAN])
    await probe({ readDaclSddl: fake.readDaclSddl })
    const before = fake.calls.length
    probeWindowsInstallDirAcl({
      platform: 'win32',
      installDir: INSTALL_DIR,
      readDaclSddl: fake.readDaclSddl
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(fake.calls).toHaveLength(before)
  })
})
