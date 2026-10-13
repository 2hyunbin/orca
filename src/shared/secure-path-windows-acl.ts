import { writeFileSync } from 'node:fs'
import { reportSecurePathHardening as report } from './secure-path-hardening-report'
import { loadWindowsSecurity, type WindowsSecurity } from './windows-security-addon'
import { findSecureDaclViolation, hardenedDaclSddl } from './windows-secure-dacl'

/**
 * Applies the ACL without blocking. `onSettled` reports the real outcome, which the return value
 * cannot: the caller's cache must not keep claiming a path is hardened when the apply failed.
 */
export function bestEffortRestrictWindowsPath(
  targetPath: string,
  isDirectory: boolean,
  onSettled?: (restricted: boolean) => void
): void {
  const security = securityFor(targetPath)
  // Why a promise even for the synchronous verdicts: callers cache the path after this returns,
  // and a callback that fired first would have its eviction overwritten.
  const outcome = security
    ? restrictAsync(security, targetPath, isDirectory)
    : Promise.resolve(false)
  // Why both arms and a terminal catch: a throw from `onSettled` itself must not become an
  // unhandled rejection, which Node's default turns into a main-process crash.
  void outcome
    .then(onSettled, () => onSettled?.(false))
    .catch((error: unknown) => reportSettlementThrow(targetPath, error))
}

/** The reporter is a caller-installed hook, the one thing here that plausibly throws. */
function reportSettlementThrow(targetPath: string, error: unknown): void {
  try {
    report(targetPath, 'settle', `hardening settlement callback threw: ${String(error)}`)
  } catch {
    // Nothing left to report through; losing one diagnostic beats crashing the main process.
  }
}

async function restrictAsync(
  security: WindowsSecurity,
  targetPath: string,
  isDirectory: boolean
): Promise<boolean> {
  // Verify first: a directory rewrite walks every descendant (seconds on a large userData), so
  // a path that already reads back correct must never pay it again.
  if (violationOf(security, targetPath, isDirectory) === null) {
    return true
  }
  try {
    await security.addon.setDaclSddlAsync(
      targetPath,
      hardenedDaclSddl(security.userSid, isDirectory)
    )
  } catch (error) {
    report(targetPath, 'apply', String(error))
    return false
  }
  return verifyAfterApply(security, targetPath, isDirectory)
}

/** Verifies and, only when that fails, rewrites the DACL on the calling thread. */
export function restrictWindowsPathSync(targetPath: string, isDirectory: boolean): boolean {
  const security = securityFor(targetPath)
  if (!security) {
    return false
  }
  if (violationOf(security, targetPath, isDirectory) === null) {
    return true
  }
  try {
    security.addon.setDaclSddl(targetPath, hardenedDaclSddl(security.userSid, isDirectory))
  } catch (error) {
    // Why not fatal: a failed apply must not crash the caller; false leaves the path retryable.
    report(targetPath, 'apply', String(error))
    return false
  }
  return verifyAfterApply(security, targetPath, isDirectory)
}

/**
 * Writes a NEW file that is restricted from the moment it exists, so its contents are never
 * readable under the directory's (possibly broader) inherited DACL. Returns whether the
 * restriction holds. Without the addon the file is written plainly and this is false; with it, a
 * failed create throws like any other write failure.
 */
export function writeRestrictedWindowsFile(targetPath: string, contents: string): boolean {
  const security = securityFor(targetPath)
  if (!security) {
    writeFileSync(targetPath, contents, { encoding: 'utf-8', mode: 0o600 })
    return false
  }
  security.addon.createFileWithDacl(
    targetPath,
    hardenedDaclSddl(security.userSid, false),
    Buffer.from(contents, 'utf-8')
  )
  // Why read it back: FAT32 and some shares accept the descriptor and silently drop it.
  return verifyAfterApply(security, targetPath, false)
}

function verifyAfterApply(
  security: WindowsSecurity,
  targetPath: string,
  isDirectory: boolean
): boolean {
  const invalid = violationOf(security, targetPath, isDirectory)
  if (invalid) {
    report(targetPath, 'verify', invalid)
    return false
  }
  return true
}

/** Why the DACL on disk is not acceptable, or null when it is. */
function violationOf(
  security: WindowsSecurity,
  targetPath: string,
  isDirectory: boolean
): string | null {
  try {
    return findSecureDaclViolation(
      security.addon.getDaclSddl(targetPath),
      security.userSid,
      isDirectory
    )
  } catch (error) {
    return String(error)
  }
}

let reportedLoadFailure = false

function securityFor(targetPath: string): WindowsSecurity | null {
  const loaded = loadWindowsSecurity()
  if (!('error' in loaded)) {
    return loaded
  }
  // Once per process: a missing addon is a packaging fault, and every secure write would repeat it.
  if (!reportedLoadFailure) {
    reportedLoadFailure = true
    report(targetPath, 'addon', loaded.error)
  }
  return null
}
