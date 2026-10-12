import type {
  InstallDirPackageGrant,
  InstallDirPackageGrantOutcome,
  InstallDirPackageGrantPass
} from './windows-install-dir-package-acl-grant'

/**
 * Shared ACL doubles for the install-dir DACL probe, repair, and recovery tests.
 * ACEs are SDDL, the shape the native `getDaclSddl` returns (`D:AI(...)(...)`).
 */

export const ORPHAN_PACKAGE_ACE = '(A;OICI;0x1200a9;;;S-1-15-2-999-999-999)'
/** ALL RESTRICTED APPLICATION PACKAGES; SDDL has no alias for it. */
export const RESTRICTED_PACKAGES_ACE = '(A;OICI;0x1200a9;;;S-1-15-2-2)'
/** ALL APPLICATION PACKAGES (`AC`), the Program Files default: healthy installs launch clean. */
export const ALL_PACKAGES_ACE = '(A;;0x1200a9;;;AC)'

export const BASELINE_ACES = [
  '(A;OICIID;FA;;;SY)',
  '(A;OICIID;FA;;;BA)',
  '(A;OICIID;FA;;;S-1-5-21-432636774-4279371817-3971399515-1001)'
]

/** The SDDL a target carrying these ACEs (plus the inherited baseline) reads back as. */
export function savedDacl(aces: string[]): string {
  return `D:AI${[...aces, ...BASELINE_ACES].join('')}`
}

/**
 * `saved` returns the target's extra ACEs, or a raw SDDL string; `null` makes the
 * read throw, as an unreadable target does.
 */
export function fakeDaclReader(saved: (target: string) => string[] | string | null): {
  readDaclSddl: (path: string) => string
  calls: string[]
} {
  const calls: string[] = []
  const readDaclSddl = (path: string): string => {
    calls.push(path)
    const aces = saved(path)
    if (aces === null) {
      throw new Error('GetNamedSecurityInfoW failed with Win32 error 5')
    }
    return typeof aces === 'string' ? aces : savedDacl(aces)
  }
  return { readDaclSddl, calls }
}

/** Records each grant pass; `reply` decides its outcome (default: success). */
export function fakePackageGrant(
  reply: (
    pass: InstallDirPackageGrantPass
  ) => Partial<InstallDirPackageGrantOutcome> | Promise<InstallDirPackageGrantOutcome> = () => ({})
): {
  grantFn: InstallDirPackageGrant
  passes: { installDir: string; pass: InstallDirPackageGrantPass }[]
} {
  const passes: { installDir: string; pass: InstallDirPackageGrantPass }[] = []
  const grantFn: InstallDirPackageGrant = async (installDir, pass) => {
    passes.push({ installDir, pass })
    const outcome = await reply(pass)
    return { ok: true, failedFileCount: 0, ...outcome }
  }
  return { grantFn, passes }
}
