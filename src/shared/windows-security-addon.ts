import { createRequire } from 'node:module'
import { join, win32 as pathWin32 } from 'node:path'
import type * as WindowsSecurityModule from '@orca/windows-security'
import { ORCAD_WINDOWS_SECURITY_FILENAME } from './orcad-artifacts'

export type WindowsSecurityAddon = typeof WindowsSecurityModule
export type { GrantAccessOptions } from '@orca/windows-security'

/** The addon and the process token's user SID, read together once. */
export type WindowsSecurity = { addon: WindowsSecurityAddon; userSid: string }

/** FILE_ALL_ACCESS, what SDDL prints as `FA`. */
export const WINDOWS_FILE_ALL_ACCESS = 0x1f01ff
/** FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, what icacls calls `(RX)`. */
export const WINDOWS_FILE_READ_EXECUTE = 0x1200a9

const requireFromHere = createRequire(__filename)

let loaded: WindowsSecurity | { error: string } | null = null

/**
 * The addon, or why it cannot load on this host. Desktop and the CLI resolve the workspace
 * package; orcad ships the bare binary at its slot root, beside its server bundles and two levels
 * above its CLI bundle (`out/cli/index.js`), with no node_modules.
 */
export function loadWindowsSecurity(): WindowsSecurity | { error: string } {
  loaded ??= loadOnce()
  return loaded
}

function loadOnce(): WindowsSecurity | { error: string } {
  if (process.platform !== 'win32') {
    return { error: `unsupported on ${process.platform}` }
  }
  const failures: string[] = []
  for (const specifier of [
    '@orca/windows-security',
    join(__dirname, ORCAD_WINDOWS_SECURITY_FILENAME),
    join(__dirname, '..', '..', ORCAD_WINDOWS_SECURITY_FILENAME)
  ]) {
    try {
      // Reading the SID is also what makes the package load its deferred .node binary.
      return prepare(requireFromHere(specifier))
    } catch (error) {
      failures.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { error: failures.join('; ') }
}

/**
 * Every path gets the extended-length prefix here, once: the Win32 security APIs are
 * MAX_PATH-limited and fail with error 123 past 259 characters.
 *
 * Async DACL writes to one path run in order. A grant reads the DACL and writes back a merge, so
 * one racing a re-lock on another pool thread could land last and restore the broader DACL.
 * A synchronous grantDirAcl is not ordered against them; it never targets the userData root.
 */
function prepare(raw: WindowsSecurityAddon): WindowsSecurity {
  const writes = new Map<string, Promise<unknown>>()
  const inPathOrder = (path: string, write: () => Promise<void>): Promise<void> => {
    const key = path.toLowerCase()
    const next = (writes.get(key) ?? Promise.resolve()).then(write, write)
    const settled = next.catch(() => undefined)
    writes.set(key, settled)
    void settled.then(() => {
      if (writes.get(key) === settled) {
        writes.delete(key)
      }
    })
    return next
  }
  return {
    userSid: raw.currentUserSid(),
    addon: {
      currentUserSid: raw.currentUserSid,
      getDaclSddl: (path) => raw.getDaclSddl(extended(path)),
      setDaclSddl: (path, sddl) => raw.setDaclSddl(extended(path), sddl),
      setDaclSddlAsync: (path, sddl) =>
        inPathOrder(extended(path), () => raw.setDaclSddlAsync(extended(path), sddl)),
      createFileWithDacl: (path, sddl, data) => raw.createFileWithDacl(extended(path), sddl, data),
      grantAccess: (path, sid, mask, options) =>
        raw.grantAccess(extended(path), sid, mask, options),
      grantAccessAsync: (path, sid, mask, options) =>
        inPathOrder(extended(path), () => raw.grantAccessAsync(extended(path), sid, mask, options))
    }
  }
}

function extended(path: string): string {
  if (path.length < 260 || path.startsWith('\\\\?\\')) {
    return path
  }
  const normalized = pathWin32.normalize(path)
  if (/^[A-Za-z]:\\/.test(normalized)) {
    return `\\\\?\\${normalized}`
  }
  return normalized.startsWith('\\\\') ? `\\\\?\\UNC\\${normalized.slice(2)}` : path
}

/** Installs `addon` (a fake, or null for "cannot load") behind the same wrapping as the real one. */
export function setWindowsSecurityForTests(addon: WindowsSecurityAddon | null): void {
  loaded = addon ? prepare(addon) : { error: 'disabled for tests' }
}

/** Forgets the loaded addon and its SID. */
export function resetWindowsSecurityLoadForTests(): void {
  loaded = null
}
