import { describe, expect, it } from 'vitest'
import { findSecureDaclViolation, hardenedDaclSddl } from './windows-secure-dacl'

const USER = 'S-1-5-21-432636774-4279371817-3971399515-1001'
const fileViolation = (sddl: string) => findSecureDaclViolation(sddl, USER, false)
const directoryViolation = (sddl: string) => findSecureDaclViolation(sddl, USER, true)

describe('findSecureDaclViolation', () => {
  it('accepts what Orca writes, for files and directories', () => {
    expect(fileViolation(hardenedDaclSddl(USER, false))).toBeNull()
    expect(directoryViolation(hardenedDaclSddl(USER, true))).toBeNull()
  })

  // No migration: these are byte-for-byte what the icacls hardening left on this machine.
  it('accepts what the icacls-era hardening left on disk', () => {
    expect(fileViolation(`D:PAI(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;${USER})`)).toBeNull()
    expect(
      directoryViolation(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})`)
    ).toBeNull()
  })

  it('accepts a protected DACL granting the user alone, and ignores deny rules', () => {
    expect(fileViolation(`D:P(A;;FA;;;${USER})`)).toBeNull()
    expect(fileViolation(`D:P(D;;FA;;;WD)(A;;FA;;;${USER})`)).toBeNull()
    expect(fileViolation(`D:P(A;;0x1f01ff;;;${USER})`)).toBeNull()
  })

  it.each([
    ['explicit Everyone', `D:P(A;;FA;;;${USER})(A;;FR;;;WD)`, 'S-1-1-0'],
    [
      'inherited Authenticated Users (a relocated root)',
      `D:AI(A;ID;FA;;;${USER})(A;ID;0x1301bf;;;AU)`,
      'S-1-5-11'
    ],
    [
      'inherit-only Users on a directory',
      `D:P(A;OICI;FA;;;${USER})(A;OICIIO;FR;;;BU)`,
      'S-1-5-32-545'
    ],
    ['an object allow rule', `D:P(A;OICI;FA;;;${USER})(OA;;FR;;;WD)`, 'S-1-1-0']
  ])('rejects %s', (_label, sddl, sid) => {
    expect(directoryViolation(sddl)).toBe(`unexpected rule for ${sid}`)
  })

  // Loosening the parent reaches anything that still inherits, however tidy it looks today.
  it('requires protection, even when every inherited rule names an allowed principal', () => {
    expect(directoryViolation(`D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;${USER})`)).toMatch(
      /not protected/
    )
    expect(fileViolation(`D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${USER})`)).toMatch(
      /not protected/
    )
  })

  // An inherit-only rule grants the directory itself nothing, so Orca could not write into it.
  it('rejects a path the user cannot actually use', () => {
    const missing = `missing full control for ${USER}`
    expect(directoryViolation(`D:P(A;OICIIO;FA;;;${USER})(A;OICI;FA;;;SY)`)).toBe(missing)
    expect(directoryViolation(`D:P(A;;FA;;;${USER})`)).toBe(missing)
    expect(fileViolation(`D:P(A;;FR;;;${USER})`)).toBe(missing)
  })

  it('fails closed on a NULL DACL, a conditional ACE, or anything else it cannot read', () => {
    for (const sddl of [
      'D:NO_ACCESS_CONTROL',
      'D:PNO_ACCESS_CONTROL',
      'O:BA',
      `D:P(A;;FA;;;SY)(A;;FA;;;${USER})(XA;;FA;;;WD;(Member_of {SID(WD)}))`
    ]) {
      expect(fileViolation(sddl)).toMatch(/no DACL/)
    }
  })

  // The built-in Administrator account reads back as `LA`, not as its SID.
  it('resolves the machine-relative alias of a RID-500 user', () => {
    const builtinAdmin = 'S-1-5-21-432636774-4279371817-3971399515-500'
    expect(findSecureDaclViolation('D:P(A;;FA;;;SY)(A;;FA;;;LA)', builtinAdmin, false)).toBeNull()
    expect(
      findSecureDaclViolation(
        'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)',
        builtinAdmin,
        true
      )
    ).toBeNull()
    // `LA` names the RID-500 account, so it is a stranger to any other user.
    expect(findSecureDaclViolation(`D:P(A;;FA;;;LA)(A;;FA;;;${USER})`, USER, false)).toBe(
      'unexpected rule for S-1-5-21-432636774-4279371817-3971399515-500'
    )
  })
})
