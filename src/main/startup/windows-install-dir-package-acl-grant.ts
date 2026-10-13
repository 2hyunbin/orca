import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizeCrashReportString } from '../../shared/crash-reporting'
import { loadWindowsSecurity, WINDOWS_FILE_READ_EXECUTE } from '../../shared/windows-security-addon'

/** ALL RESTRICTED APPLICATION PACKAGES: the grant that cleared electron/electron#51761. */
export const RESTRICTED_APP_PACKAGES_SID = 'S-1-15-2-2'

export type InstallDirPackageGrantOutcome = {
  ok: boolean
  /** Entries whose DACL could not be written (or read, for a directory listing). */
  failedFileCount: number
  reason?: string
}

/**
 * `root`: one inheritable grant, so files a later update writes inherit it.
 * `tree`: a flagless grant on every existing entry, because a shipped module that carries its
 * own explicit DACL inherits nothing from the root.
 */
export type InstallDirPackageGrantPass = 'root' | 'tree'

export type InstallDirPackageGrant = (
  installDir: string,
  pass: InstallDirPackageGrantPass
) => Promise<InstallDirPackageGrantOutcome>

export type GrantEntry = (path: string, inheritable: boolean) => Promise<void>

/** The in-process grant; never `replace`, so SYSTEM, Administrators, the user and the orphan all survive. */
export function nativeInstallDirPackageGrant(): InstallDirPackageGrant {
  return (installDir, pass) => {
    const security = loadWindowsSecurity()
    if (!('addon' in security)) {
      return Promise.resolve({ ok: false, failedFileCount: 0, reason: 'addon-unavailable' })
    }
    const grantEntry: GrantEntry = (path, inheritable) =>
      security.addon.grantAccessAsync(
        path,
        RESTRICTED_APP_PACKAGES_SID,
        WINDOWS_FILE_READ_EXECUTE,
        {
          inheritable,
          replace: false
        }
      )
    return pass === 'root' ? grantRoot(grantEntry, installDir) : grantTree(grantEntry, installDir)
  }
}

async function grantRoot(
  grantEntry: GrantEntry,
  installDir: string
): Promise<InstallDirPackageGrantOutcome> {
  try {
    await grantEntry(installDir, true)
    return { ok: true, failedFileCount: 0 }
  } catch (error) {
    return { ok: false, failedFileCount: 1, reason: sanitizeCrashReportString(String(error), 200) }
  }
}

/** Every entry, the root included, continuing past failures the way `icacls /T /C` did. */
export async function grantTree(
  grantEntry: GrantEntry,
  installDir: string
): Promise<InstallDirPackageGrantOutcome> {
  let failedFileCount = 0
  let firstFailure: string | undefined
  const fail = (error: unknown): void => {
    failedFileCount += 1
    firstFailure ??= sanitizeCrashReportString(String(error), 200)
  }
  const pending = [installDir]
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    try {
      await grantEntry(directory, false)
    } catch (error) {
      fail(error)
    }
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      fail(error)
      continue
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      // Never through a link: a junction can point anywhere, and the repair is for this tree.
      if (entry.isSymbolicLink()) {
        continue
      }
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      try {
        await grantEntry(path, false)
      } catch (error) {
        fail(error)
      }
    }
  }
  return failedFileCount === 0
    ? { ok: true, failedFileCount: 0 }
    : { ok: false, failedFileCount, reason: `failed-files: ${firstFailure}` }
}
