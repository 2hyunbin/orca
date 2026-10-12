import { localDomainSidOf, parseSddlDacl, type WindowsAce } from './windows-security-descriptor'

/** SYSTEM and the local Administrators group: they can take ownership regardless, so denying them buys nothing. */
export const LOCAL_SYSTEM_SID = 'S-1-5-18'
export const BUILTIN_ADMINISTRATORS_SID = 'S-1-5-32-544'

/** Every allow-type ACE kind SDDL can print: plain, object, callback, callback-object. */
const ALLOW_ACE_TYPES = new Set(['A', 'OA', 'XA', 'ZA'])
const FILE_ALL_ACCESS = 0x1f01ff

/**
 * The DACL Orca installs on a secure path: protected, full control to the user, SYSTEM and
 * Administrators only. A directory's rules are inheritable so files created inside it start
 * restricted too.
 */
export function hardenedDaclSddl(userSid: string, isDirectory: boolean): string {
  const flags = isDirectory ? 'OICI' : ''
  return `D:P(A;${flags};FA;;;${LOCAL_SYSTEM_SID})(A;${flags};FA;;;${BUILTIN_ADMINISTRATORS_SID})(A;${flags};FA;;;${userSid})`
}

export type SecureDaclExpectation = {
  userSid: string
  isDirectory: boolean
  /** The parent directory's DACL, read only when the path's own DACL is not protected. */
  readParentSddl?: () => string | null
}

/**
 * OpenSSH's rule (only the user, SYSTEM and Administrators may be granted anything, inherited or
 * explicit) plus two of Orca's own: loosening a parent must not reach the path, and the user must
 * still be able to use it. Returns why the DACL fails, or null when it is acceptable.
 *
 * Why not "exactly the DACL Orca writes": files hardened by older builds, and files a hardened
 * directory hands down by inheritance, are just as private and must not be rewritten.
 */
export function findSecureDaclViolation(
  sddl: string,
  expectation: SecureDaclExpectation
): string | null {
  // A NULL DACL (FAT32, some shares) grants everyone everything.
  if (/D:[A-Z]*NO_ACCESS_CONTROL/.test(sddl)) {
    return 'the path has no DACL, so everyone has full control'
  }
  const localDomainSid = localDomainSidOf(expectation.userSid) ?? undefined
  const dacl = parseSddlDacl(sddl, localDomainSid)
  if (!dacl) {
    return 'no DACL in the security descriptor'
  }
  const allowed = new Set([expectation.userSid, LOCAL_SYSTEM_SID, BUILTIN_ADMINISTRATORS_SID])
  const stranger = dacl.aces.find((ace) => ALLOW_ACE_TYPES.has(ace.type) && !allowed.has(ace.sid))
  if (stranger) {
    return `unexpected rule for ${stranger.sid}`
  }
  if (!dacl.isProtected && !inheritsFromSecureParent(dacl.aces, expectation)) {
    return 'DACL is not protected; the parent still propagates into it'
  }
  const usable = dacl.aces.some(
    (ace) =>
      ace.type === 'A' &&
      ace.sid === expectation.userSid &&
      !ace.flags.includes('IO') &&
      grantsFullControl(ace.rights) &&
      (!expectation.isDirectory || (ace.flags.includes('OI') && ace.flags.includes('CI')))
  )
  // An inherit-only rule grants the directory itself nothing, so Orca could not write into it.
  if (!usable) {
    return `missing full control for ${expectation.userSid}`
  }
  return null
}

/** A file whose every rule comes from a parent that is itself secure is as private as that parent. */
function inheritsFromSecureParent(aces: WindowsAce[], expectation: SecureDaclExpectation): boolean {
  if (
    expectation.isDirectory ||
    aces.length === 0 ||
    !aces.every((ace) => ace.flags.includes('ID'))
  ) {
    return false
  }
  const parentSddl = expectation.readParentSddl?.()
  return (
    !!parentSddl &&
    findSecureDaclViolation(parentSddl, { userSid: expectation.userSid, isDirectory: true }) ===
      null
  )
}

function grantsFullControl(rights: string): boolean {
  if (rights === 'FA' || rights === 'GA') {
    return true
  }
  if (!/^0X[0-9A-F]+$/.test(rights)) {
    return false
  }
  return (Number.parseInt(rights.slice(2), 16) & FILE_ALL_ACCESS) === FILE_ALL_ACCESS
}
