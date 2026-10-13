import type { WindowsSecurityAddon } from './windows-security-addon'
import { localDomainSidOf, parseSddlDacl, type WindowsDacl } from './windows-security-descriptor'

/** The path's DACL with machine-relative aliases resolved: a RID-500 user reads back as `LA`. */
export function readDaclOf(
  addon: WindowsSecurityAddon,
  path: string,
  userSid: string
): WindowsDacl | null {
  return parseSddlDacl(addon.getDaclSddl(path), localDomainSidOf(userSid) ?? undefined)
}
