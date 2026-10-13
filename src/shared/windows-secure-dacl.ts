import { WINDOWS_FILE_ALL_ACCESS } from './windows-security-addon'
import { localDomainSidOf, parseSddlDacl } from './windows-security-descriptor'

/** SYSTEM and the local Administrators group: they can take ownership regardless, so denying them buys nothing. */
export const LOCAL_SYSTEM_SID = 'S-1-5-18'
export const BUILTIN_ADMINISTRATORS_SID = 'S-1-5-32-544'

/** Every allow-type ACE kind SDDL can print: plain, object, callback, callback-object. */
const ALLOW_ACE_TYPES = new Set(['A', 'OA', 'XA', 'ZA'])

/**
 * The DACL Orca installs on a secure path: protected, full control to the user, SYSTEM and
 * Administrators only. A directory's rules are inheritable so files created inside it start
 * restricted too.
 */
export function hardenedDaclSddl(userSid: string, isDirectory: boolean): string {
  const flags = isDirectory ? 'OICI' : ''
  return `D:P(A;${flags};FA;;;${LOCAL_SYSTEM_SID})(A;${flags};FA;;;${BUILTIN_ADMINISTRATORS_SID})(A;${flags};FA;;;${userSid})`
}

/**
 * OpenSSH's ACE rule (only the user, SYSTEM and Administrators may be allowed anything, inherited
 * or explicit) plus two of Orca's own: the DACL is protected, so loosening a parent cannot reach
 * the path, and the user can still use it. Returns why the DACL fails, or null when it passes.
 *
 * Why not "exactly the DACL Orca writes": what older builds wrote is just as private and must not
 * be rewritten.
 */
export function findSecureDaclViolation(
  sddl: string,
  userSid: string,
  isDirectory: boolean
): string | null {
  const dacl = parseSddlDacl(sddl, localDomainSidOf(userSid) ?? undefined)
  // Also a NULL DACL (`D:NO_ACCESS_CONTROL`, FAT32 and some shares), which grants everyone everything.
  if (!dacl) {
    return 'no DACL Orca can read in the security descriptor'
  }
  const allowed = new Set([userSid, LOCAL_SYSTEM_SID, BUILTIN_ADMINISTRATORS_SID])
  const stranger = dacl.aces.find((ace) => ALLOW_ACE_TYPES.has(ace.type) && !allowed.has(ace.sid))
  if (stranger) {
    return `unexpected rule for ${stranger.sid}`
  }
  if (!dacl.isProtected) {
    return 'DACL is not protected; the parent still propagates into it'
  }
  // An inherit-only rule grants the directory itself nothing, so Orca could not write into it.
  const usable = dacl.aces.some(
    (ace) =>
      ace.type === 'A' &&
      ace.sid === userSid &&
      !ace.flags.includes('IO') &&
      grantsFullControl(ace.rights) &&
      (!isDirectory || (ace.flags.includes('OI') && ace.flags.includes('CI')))
  )
  return usable ? null : `missing full control for ${userSid}`
}

function grantsFullControl(rights: string): boolean {
  if (rights === 'FA' || rights === 'GA') {
    return true
  }
  return (
    /^0X[0-9A-F]+$/.test(rights) &&
    (Number.parseInt(rights.slice(2), 16) & WINDOWS_FILE_ALL_ACCESS) === WINDOWS_FILE_ALL_ACCESS
  )
}
