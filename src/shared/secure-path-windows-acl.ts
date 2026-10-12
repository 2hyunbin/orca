import { writeFileSync } from 'node:fs'
import { win32 as pathWin32 } from 'node:path'
import {
  reportSecurePathHardening,
  type SecurePathHardeningReport
} from './secure-path-hardening-report'
import {
  loadWindowsSecurityAddon,
  windowsSecurityAddonLoadError,
  type WindowsSecurityAddon
} from './windows-security-addon'
import { findSecureDaclViolation, hardenedDaclSddl } from './windows-secure-dacl'

type AclPlan = {
  addon: WindowsSecurityAddon
  /** Extended-length prefixed when needed. */
  path: string
  isDirectory: boolean
  userSid: string
  sddl: string
}

function report(
  targetPath: string,
  stage: SecurePathHardeningReport['stage'],
  detail: string
): void {
  reportSecurePathHardening(targetPath, stage, detail)
}

/**
 * Applies the ACL without blocking. `onSettled` reports the real outcome, which the return value
 * cannot: the caller's cache must not keep claiming a path is hardened when the apply failed.
 */
export function bestEffortRestrictWindowsPath(
  targetPath: string,
  isDirectory: boolean,
  onSettled?: (restricted: boolean) => void
): void {
  const plan = planFor(targetPath, isDirectory)
  // Why a promise even for the synchronous verdicts: callers cache the path after this returns,
  // and a callback that fired first would have its eviction overwritten.
  const outcome = plan ? restrictAsync(targetPath, plan) : Promise.resolve(false)
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

async function restrictAsync(targetPath: string, plan: AclPlan): Promise<boolean> {
  // Verify first: a directory rewrite walks every descendant (seconds on a large userData), so
  // a path that already reads back correct must never pay it again.
  if (verify(plan) === null) {
    return true
  }
  try {
    await plan.addon.setDaclSddlAsync(plan.path, plan.sddl)
  } catch (error) {
    report(targetPath, 'apply', String(error))
    return false
  }
  return verifyAfterApply(targetPath, plan)
}

/** Verifies and, only when that fails, rewrites the DACL on the calling thread. */
export function restrictWindowsPathSync(targetPath: string, isDirectory: boolean): boolean {
  const plan = planFor(targetPath, isDirectory)
  if (!plan) {
    return false
  }
  if (verify(plan) === null) {
    return true
  }
  try {
    plan.addon.setDaclSddl(plan.path, plan.sddl)
  } catch (error) {
    // Why not fatal: a failed apply must not crash the caller; false leaves the path retryable.
    report(targetPath, 'apply', String(error))
    return false
  }
  return verifyAfterApply(targetPath, plan)
}

/**
 * Writes a NEW file that is restricted from the moment it exists, so its contents are never
 * readable under the directory's (possibly broader) inherited DACL. Returns whether the
 * restriction holds; when the addon cannot do it, the file is still written and this is false.
 */
export function writeRestrictedWindowsFile(targetPath: string, contents: string): boolean {
  const plan = planFor(targetPath, false)
  if (plan) {
    try {
      plan.addon.createFileWithDacl(plan.path, plan.sddl, Buffer.from(contents, 'utf-8'))
      // Why read it back: FAT32 and some shares accept the descriptor and silently drop it.
      return verifyAfterApply(targetPath, plan)
    } catch (error) {
      report(targetPath, 'create', String(error))
    }
  }
  // Same bytes, inherited DACL: a real filesystem failure surfaces here as the usual Node error.
  writeFileSync(targetPath, contents, { encoding: 'utf-8', mode: 0o600 })
  return false
}

function verifyAfterApply(targetPath: string, plan: AclPlan): boolean {
  const invalid = verify(plan)
  if (invalid) {
    report(targetPath, 'verify', invalid)
    return false
  }
  return true
}

/** Why the DACL on disk is not acceptable, or null when it is. */
function verify(plan: AclPlan): string | null {
  let sddl: string
  try {
    sddl = plan.addon.getDaclSddl(plan.path)
  } catch (error) {
    return String(error)
  }
  return findSecureDaclViolation(sddl, {
    userSid: plan.userSid,
    isDirectory: plan.isDirectory,
    readParentSddl: () => {
      try {
        return plan.addon.getDaclSddl(toExtendedLengthPath(pathWin32.dirname(plan.path)))
      } catch {
        return null
      }
    }
  })
}

/**
 * The Win32 path APIs here are MAX_PATH-limited and fail past 259 characters; the extended
 * prefix is the documented escape.
 */
function toExtendedLengthPath(targetPath: string): string {
  if (targetPath.length < 260 || targetPath.startsWith('\\\\?\\')) {
    return targetPath
  }
  const normalized = pathWin32.normalize(targetPath)
  if (/^[A-Za-z]:\\/.test(normalized)) {
    return `\\\\?\\${normalized}`
  }
  if (normalized.startsWith('\\\\')) {
    return `\\\\?\\UNC\\${normalized.slice(2)}`
  }
  return targetPath
}

let addonFailureReported = false

function planFor(targetPath: string, isDirectory: boolean): AclPlan | null {
  const addon = loadWindowsSecurityAddon()
  if (!addon) {
    // Once per process: a missing addon is a packaging fault, and every secure write would repeat it.
    if (!addonFailureReported) {
      addonFailureReported = true
      report(targetPath, 'addon', windowsSecurityAddonLoadError() ?? 'not loaded')
    }
    return null
  }
  const userSid = getCurrentWindowsUserSid(addon, targetPath)
  if (!userSid) {
    return null
  }
  return {
    addon,
    path: toExtendedLengthPath(targetPath),
    isDirectory,
    userSid,
    sddl: hardenedDaclSddl(userSid, isDirectory)
  }
}

let cachedWindowsUserSid: string | null = null

/** The token's user never changes in-process, so one successful read serves the process. */
function getCurrentWindowsUserSid(addon: WindowsSecurityAddon, targetPath: string): string | null {
  if (cachedWindowsUserSid) {
    return cachedWindowsUserSid
  }
  try {
    cachedWindowsUserSid = addon.currentUserSid()
    return cachedWindowsUserSid
  } catch (error) {
    report(targetPath, 'sid-lookup', String(error))
    return null
  }
}

export function resetSecureFileWindowsUserSidForTests(): void {
  cachedWindowsUserSid = null
  addonFailureReported = false
}
