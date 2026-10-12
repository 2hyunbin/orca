import { createRequire } from 'node:module'
import { join } from 'node:path'
import { ORCAD_WINDOWS_SECURITY_FILENAME } from './orcad-artifacts'

export type WindowsSecurityGrantOptions = {
  /** Children inherit the grant (OI|CI). Only meaningful on a directory. */
  inheritable: boolean
  /** Replace the trustee's explicit allow rules (`icacls /grant:r`) instead of merging. */
  replace: boolean
}

/** native/windows-security. Every call throws an Error carrying `winCode` on a Win32 failure. */
export type WindowsSecurityAddon = {
  currentUserSid: () => string
  getDaclSddl: (path: string) => string
  setDaclSddl: (path: string, sddl: string) => void
  setDaclSddlAsync: (path: string, sddl: string) => Promise<void>
  createFileWithDacl: (path: string, sddl: string, data: Uint8Array) => void
  grantAccess: (
    path: string,
    sid: string,
    accessMask: number,
    options: WindowsSecurityGrantOptions
  ) => void
  grantAccessAsync: (
    path: string,
    sid: string,
    accessMask: number,
    options: WindowsSecurityGrantOptions
  ) => Promise<void>
}

/** FILE_ALL_ACCESS, what SDDL prints as `FA`. */
export const WINDOWS_FILE_ALL_ACCESS = 0x1f01ff
/** FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, what icacls calls `(RX)`. */
export const WINDOWS_FILE_READ_EXECUTE = 0x1200a9

const requireFromHere = createRequire(__filename)

let loaded: { addon: WindowsSecurityAddon | null; error: string | null } | null = null

/**
 * The addon, or null when it cannot load on this host. Desktop and the CLI resolve the workspace
 * package; orcad ships the bare binary at its slot root, beside its server bundles and two levels
 * above its CLI bundle (`out/cli/index.js`), with no node_modules.
 */
export function loadWindowsSecurityAddon(): WindowsSecurityAddon | null {
  if (!loaded) {
    loaded = loadOnce()
  }
  return loaded.addon
}

/** Why the load failed, for the one diagnostic a caller logs; null when it loaded. */
export function windowsSecurityAddonLoadError(): string | null {
  loadWindowsSecurityAddon()
  return loaded?.error ?? null
}

function loadOnce(): { addon: WindowsSecurityAddon | null; error: string | null } {
  if (process.platform !== 'win32') {
    return { addon: null, error: `unsupported on ${process.platform}` }
  }
  const failures: string[] = []
  for (const specifier of [
    '@orca/windows-security',
    join(__dirname, ORCAD_WINDOWS_SECURITY_FILENAME),
    join(__dirname, '..', '..', ORCAD_WINDOWS_SECURITY_FILENAME)
  ]) {
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every specifier is a build of native/windows-security, whose exports index.d.ts declares; the probe call below proves the binary actually loads.
      const addon = requireFromHere(specifier) as WindowsSecurityAddon
      // The package defers its .node load to the first call; make that happen here.
      addon.currentUserSid()
      return { addon, error: null }
    } catch (error) {
      failures.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { addon: null, error: failures.join('; ') }
}

export function setWindowsSecurityAddonForTests(addon: WindowsSecurityAddon | null): void {
  loaded = { addon, error: addon ? null : 'disabled for tests' }
}

export function resetWindowsSecurityAddonForTests(): void {
  loaded = null
}
