import { describe, expect, it } from 'vitest'
import { findSecureDaclViolation, hardenedDaclSddl } from './windows-secure-dacl'

const USER = 'S-1-5-21-432636774-4279371817-3971399515-1001'
const file = { userSid: USER, isDirectory: false }
const directory = { userSid: USER, isDirectory: true }

describe('findSecureDaclViolation', () => {
  it('accepts what Orca writes, for files and directories', () => {
    expect(findSecureDaclViolation(hardenedDaclSddl(USER, false), file)).toBeNull()
    expect(findSecureDaclViolation(hardenedDaclSddl(USER, true), directory)).toBeNull()
  })

  // No migration: these are byte-for-byte what the icacls hardening left on this machine.
  it('accepts what the icacls-era hardening left on disk', () => {
    expect(
      findSecureDaclViolation(`D:PAI(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;${USER})`, file)
    ).toBeNull()
    expect(
      findSecureDaclViolation(
        `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})`,
        directory
      )
    ).toBeNull()
  })

  it('accepts a protected DACL granting the user alone, and ignores deny rules', () => {
    expect(findSecureDaclViolation(`D:P(A;;FA;;;${USER})`, file)).toBeNull()
    expect(findSecureDaclViolation(`D:P(D;;FA;;;WD)(A;;FA;;;${USER})`, file)).toBeNull()
    expect(findSecureDaclViolation(`D:P(A;;0x1f01ff;;;${USER})`, file)).toBeNull()
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
    ['an object allow rule', `D:P(A;;FA;;;${USER})(OA;;FR;;;WD)`, 'S-1-1-0']
  ])('rejects %s', (_label, sddl, sid) => {
    expect(findSecureDaclViolation(sddl, directory)).toBe(`unexpected rule for ${sid}`)
  })

  it('requires a directory to be protected so loosening its parent cannot reach it', () => {
    expect(
      findSecureDaclViolation(`D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;${USER})`, directory)
    ).toMatch(/not protected/)
  })

  it('accepts a fully inherited file only when its parent is itself secure', () => {
    const inherited = `D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${USER})`
    const secureParent = () => hardenedDaclSddl(USER, true)
    const looseParent = () => `D:AI(A;OICIID;FA;;;${USER})`
    expect(findSecureDaclViolation(inherited, { ...file, readParentSddl: secureParent })).toBeNull()
    expect(findSecureDaclViolation(inherited, { ...file, readParentSddl: looseParent })).toMatch(
      /not protected/
    )
    expect(findSecureDaclViolation(inherited, { ...file, readParentSddl: () => null })).toMatch(
      /not protected/
    )
    // A mix of explicit and inherited rules is not "handed down by a secure parent".
    expect(
      findSecureDaclViolation(`D:AI(A;;FA;;;${USER})(A;ID;FA;;;SY)`, {
        ...file,
        readParentSddl: secureParent
      })
    ).toMatch(/not protected/)
  })

  // An inherit-only rule grants the directory itself nothing, so Orca could not write into it.
  it('rejects a directory the user cannot actually use', () => {
    expect(findSecureDaclViolation(`D:P(A;OICIIO;FA;;;${USER})(A;OICI;FA;;;SY)`, directory)).toBe(
      `missing full control for ${USER}`
    )
    expect(findSecureDaclViolation(`D:P(A;;FA;;;${USER})`, directory)).toBe(
      `missing full control for ${USER}`
    )
    expect(findSecureDaclViolation(`D:P(A;;FR;;;${USER})`, file)).toBe(
      `missing full control for ${USER}`
    )
  })

  it('rejects a NULL DACL, which grants everyone everything', () => {
    expect(findSecureDaclViolation('D:NO_ACCESS_CONTROL', file)).toMatch(/no DACL/)
    expect(findSecureDaclViolation('D:PNO_ACCESS_CONTROL', file)).toMatch(/no DACL/)
    expect(findSecureDaclViolation('O:BA', file)).toMatch(/no DACL/)
  })

  // The built-in Administrator account reads back as `LA`, not as its SID.
  it('resolves the machine-relative alias of a RID-500 user', () => {
    const builtinAdmin = 'S-1-5-21-432636774-4279371817-3971399515-500'
    expect(
      findSecureDaclViolation('D:P(A;;FA;;;SY)(A;;FA;;;LA)', {
        userSid: builtinAdmin,
        isDirectory: false
      })
    ).toBeNull()
  })
})
