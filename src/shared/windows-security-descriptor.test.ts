import { describe, expect, it } from 'vitest'
import { localDomainSidOf, parseSddlDacl, resolveSddlSid } from './windows-security-descriptor'

const MACHINE_SID = 'S-1-5-21-432636774-4279371817-3971399515'
const USER_SID = `${MACHINE_SID}-1001`
/** The built-in Administrator: the account a CI runner and an Administrator-only box log in as. */
const LOCAL_ADMIN_SID = `${MACHINE_SID}-500`

describe('parseSddlDacl', () => {
  it('reads a hardened file descriptor as icacls /save emits it', () => {
    const dacl = parseSddlDacl(`D:PAI(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;${USER_SID})`)

    expect(dacl?.isProtected).toBe(true)
    expect(dacl?.aces).toEqual([
      { type: 'A', flags: [], rights: 'FA', sid: 'S-1-5-32-544' },
      { type: 'A', flags: [], rights: 'FA', sid: 'S-1-5-18' },
      { type: 'A', flags: [], rights: 'FA', sid: USER_SID }
    ])
  })

  it('reads the inheritable flags a hardened directory carries', () => {
    const dacl = parseSddlDacl('D:PAI(A;OICI;FA;;;SY)')

    expect(dacl?.aces[0]!.flags).toEqual(['OI', 'CI'])
  })

  it('reports an unprotected descriptor and its inherited rules', () => {
    const dacl = parseSddlDacl(`D:(A;ID;FA;;;SY)(A;ID;FA;;;${USER_SID})`)

    expect(dacl?.isProtected).toBe(false)
    expect(dacl?.aces.map((ace) => ace.flags)).toEqual([['ID'], ['ID']])
  })

  // `OICIID` is three tokens, not a string to search: a substring test for 'ID' would also fire on
  // flag runs that merely happen to contain those letters in sequence.
  it('splits a flag run into two-letter tokens', () => {
    expect(parseSddlDacl('D:P(A;OICIID;FA;;;SY)')?.aces[0]!.flags).toEqual(['OI', 'CI', 'ID'])
    expect(parseSddlDacl('D:P(A;OICI;FA;;;SY)')?.aces[0]!.flags).not.toContain('ID')
  })

  // The addon asks for the DACL alone, so anything around it means the input is not what was read.
  it('fails closed on SDDL that carries more than a DACL', () => {
    expect(parseSddlDacl('D:P(A;;FA;;;SY)S:AI(AU;SAFA;FA;;;WD)')).toBeNull()
    expect(parseSddlDacl('O:WDG:WDD:P(A;;FA;;;SY)')).toBeNull()
  })

  // A conditional ACE body holds parentheses; stopping before it would accept a DACL granting Everyone.
  it.each([
    ['last', `D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${USER_SID})(XA;;FA;;;WD;(Member_of {SID(WD)}))`],
    ['first', `D:P(XA;;FA;;;WD;(Member_of {SID(WD)}))(A;;FA;;;SY)(A;;FA;;;${USER_SID})`]
  ])('fails closed on a conditional ACE placed %s', (_position, sddl) => {
    expect(parseSddlDacl(sddl)).toBeNull()
  })

  it('returns null when there is no DACL', () => {
    expect(parseSddlDacl('O:BAG:BA')).toBeNull()
  })

  it('returns null for a truncated ACE rather than guessing its fields', () => {
    expect(parseSddlDacl('D:P(A;;FA)')).toBeNull()
  })

  /**
   * The DACL a box whose user *is* the built-in Administrator reads back: icacls writes `LA`
   * where it wrote the raw SID for any other account, so identity checking has to resolve it or
   * the path it just hardened verifies as wrong and hardening reports failure forever.
   */
  it('resolves the built-in Administrator alias against the machine SID', () => {
    const dacl = parseSddlDacl(`D:PAI(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;LA)`, MACHINE_SID)

    expect(dacl?.aces.map((ace) => ace.sid)).toEqual(['S-1-5-32-544', 'S-1-5-18', LOCAL_ADMIN_SID])
  })

  it('leaves the alias unresolved when no machine SID is known, so it matches nothing', () => {
    const dacl = parseSddlDacl('D:PAI(A;;FA;;;LA)')

    expect(dacl?.aces[0]!.sid).toBe('LA')
  })
})

describe('resolveSddlSid', () => {
  it('resolves the aliases icacls substitutes for well-known SIDs', () => {
    expect(resolveSddlSid('WD')).toBe('S-1-1-0')
    expect(resolveSddlSid('BA')).toBe('S-1-5-32-544')
    expect(resolveSddlSid('SY')).toBe('S-1-5-18')
    expect(resolveSddlSid('AU')).toBe('S-1-5-11')
  })

  it('passes a raw SID through unchanged', () => {
    expect(resolveSddlSid(USER_SID)).toBe(USER_SID)
  })

  // An unknown alias must not silently compare equal to anything expected.
  it('passes an unrecognized alias through instead of dropping it', () => {
    expect(resolveSddlSid('ZZ')).toBe('ZZ')
  })

  // No fixed table can hold these: the SID they name is built from the machine's own.
  it('builds the machine-relative aliases from the supplied machine SID', () => {
    expect(resolveSddlSid('LA', MACHINE_SID)).toBe(LOCAL_ADMIN_SID)
    expect(resolveSddlSid('LG', MACHINE_SID)).toBe(`${MACHINE_SID}-501`)
  })

  it('keeps a machine-relative alias unresolved without a machine SID', () => {
    expect(resolveSddlSid('LA')).toBe('LA')
  })
})

describe('localDomainSidOf', () => {
  it('strips the RID off a domain-relative account SID', () => {
    expect(localDomainSidOf(USER_SID)).toBe(MACHINE_SID)
    expect(localDomainSidOf(LOCAL_ADMIN_SID)).toBe(MACHINE_SID)
  })

  // SYSTEM and the built-in groups carry no machine authority to resolve `LA` against.
  it('returns null for SIDs that are not domain-relative', () => {
    expect(localDomainSidOf('S-1-5-18')).toBeNull()
    expect(localDomainSidOf('S-1-5-32-544')).toBeNull()
    expect(localDomainSidOf('S-1-1-0')).toBeNull()
  })
})
