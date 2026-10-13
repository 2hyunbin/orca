import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_HARDENING_CACHE_BOUNDS,
  SecurePathHardeningCache,
  type SecurePathHardeningCacheBounds
} from './secure-path-hardening-cache'
import {
  configureHardeningRetryBudget,
  mayAttemptHardening,
  recordHardeningOutcome
} from './secure-path-hardening-retry-budget'
import {
  bestEffortRestrictWindowsPath,
  resetSecureFileWindowsUserSidForTests,
  restrictWindowsPathSync,
  writeRestrictedWindowsFile
} from './secure-path-windows-acl'
import {
  getHardenedPathCacheEntry,
  hardenedPathCacheEntriesMatch,
  type HardenedPathCacheEntry
} from './secure-path-metadata-snapshot'

const UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])

// Why: read paths poll (~2/s, #4901); a metadata-keyed cache keeps an unchanged file from being re-verified and re-logged.
let hardenedPathsThisProcess = new SecurePathHardeningCache<HardenedPathCacheEntry>(
  DEFAULT_HARDENING_CACHE_BOUNDS
)

// Why: child writes constantly bump a dir's mtime, so cache dirs by path (not metadata); a Windows rewrite walks the whole tree.
// Limitation: a dir deleted+recreated in-process won't re-harden; fine since we never delete our secure dirs at runtime.
let hardenedDirectoryPathsThisProcess = new SecurePathHardeningCache<true>(
  DEFAULT_HARDENING_CACHE_BOUNDS
)

function hardenSecureDirectoryOnce(dirPath: string): void {
  // Why async: a Windows directory rewrite propagates to every descendant, ~2 s on a 29k-entry userData.
  if (hardenedDirectoryPathsThisProcess.get(dirPath)) {
    return
  }
  // Cache before the ACL lands so concurrent writes don't restorm; a failure drops it, under the retry budget.
  hardenedDirectoryPathsThisProcess.set(dirPath, true)
  applySecurePathRestriction(dirPath, true, process.platform, false, (restricted) => {
    if (!restricted) {
      hardenedDirectoryPathsThisProcess.delete(dirPath)
    }
  })
}

function hardenSecurePathOnce(targetPath: string, isDirectory: boolean): boolean {
  if (isDirectory && process.platform === 'win32') {
    hardenSecureDirectoryOnce(targetPath)
    return true
  }

  const currentEntry = getHardenedPathCacheEntry(targetPath, isDirectory)
  if (!currentEntry) {
    hardenedPathsThisProcess.delete(targetPath)
  }
  const cachedEntry = hardenedPathsThisProcess.get(targetPath)
  if (currentEntry && cachedEntry && hardenedPathCacheEntriesMatch(currentEntry, cachedEntry)) {
    return true
  }
  if (process.platform === 'win32') {
    return hardenExistingWindowsFile(targetPath)
  }
  // Why: async re-harden is safe here — read path hardens each file at most once/process; new files harden synchronously on the write path.
  const outcome = applySecurePathRestriction(
    targetPath,
    isDirectory,
    process.platform,
    false,
    (restricted) => {
      if (!restricted) {
        hardenedPathsThisProcess.delete(targetPath)
      }
    }
  )
  if (outcome !== 'failed') {
    rememberHardenedPath(targetPath, isDirectory)
    return true
  }
  return false
}

/** A file has no descendants, so verifying and fixing it in-process costs microseconds. */
function hardenExistingWindowsFile(targetPath: string): boolean {
  // Why the floor: this is the read path, polled at ~2/s; a host that can never restrict
  // (FAT32, some shares) would otherwise log on every poll.
  if (!mayAttemptHardening(targetPath)) {
    return false
  }
  // The sync lane records a success itself; only a failure is left to record here.
  const restricted =
    applySecurePathRestriction(targetPath, false, process.platform, true) === 'applied'
  if (restricted) {
    rememberHardenedPath(targetPath, false)
  } else {
    recordHardeningOutcome(targetPath, false)
  }
  return restricted
}

/** Returns false when the file was written but its permissions could not be restricted. */
export function writeSecureJsonFile(targetPath: string, value: unknown): boolean {
  return writeSecureFile(targetPath, JSON.stringify(value, null, 2))
}

/** Returns false when the file was written but its permissions could not be restricted. */
export function writeDurableSecureJsonFile(targetPath: string, value: unknown): boolean {
  return writeSecureFile(targetPath, JSON.stringify(value, null, 2), { durable: true })
}

/**
 * Writes `contents` and restricts the result to the current user.
 *
 * Returns whether the restriction actually took. Hardening stays best-effort — it fails
 * legitimately on FAT32, network paths and restricted tokens, and must not break a write — but
 * the outcome is now reported rather than assumed, so a caller storing a credential can react.
 *
 * An optional publication predicate runs after staged hardening; false discards the staged file.
 *
 * The return value covers the *file* only. The parent directory is hardened fire-and-forget — on
 * Windows that lane is async and answers `pending` regardless — so a `true` here says nothing
 * about the directory's ACL.
 */
export function writeSecureFile(
  targetPath: string,
  contents: string,
  options: { durable?: boolean; shouldPublish?: () => boolean } = {}
): boolean {
  const dir = dirname(targetPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  // Windows dir hardening stays async + path-cached (it stormed the main thread, #4901); POSIX keeps the metadata cache to catch chmod/ctime drift.
  hardenSecurePathOnce(dir, true)

  const tmpFile = `${targetPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  const isWindows = process.platform === 'win32'
  try {
    // Why born restricted on Windows: writeFileSync's mode is a no-op there, and a file created
    // plainly would hold the credential under the directory's inherited DACL until a later fix.
    const stagedRestricted = isWindows
      ? writeRestrictedWindowsFile(tmpFile, contents)
      : writeStagedPosixFile(tmpFile, contents)
    if (options.durable) {
      fsyncFileSync(tmpFile)
    }
    // Recheck after hardening; the check and rename are separate, non-atomic operations.
    if (options.shouldPublish && !options.shouldPublish()) {
      rmSync(tmpFile, { force: true })
      return false
    }
    renameSync(tmpFile, targetPath)
    // A rename keeps the file's own DACL, so Windows needs no second pass; POSIX re-chmods the
    // published path in case the rename replaced a differently-moded inode.
    const publishedRestricted = isWindows
      ? stagedRestricted
      : applySecurePathRestriction(targetPath, false, process.platform, true) === 'applied'
    // Cache only on confirmed success so failures retry.
    if (publishedRestricted) {
      rememberHardenedPath(targetPath, false)
      if (isWindows) {
        // How a recovered host clears the read path's backoff (and reports `recovered`).
        recordHardeningOutcome(targetPath, true)
      }
    }
    if (options.durable) {
      bestEffortFsyncDirectorySync(dir)
    }
    return stagedRestricted && publishedRestricted
  } catch (error) {
    rmSync(tmpFile, { force: true })
    throw error
  }
}

function writeStagedPosixFile(tmpFile: string, contents: string): boolean {
  writeFileSync(tmpFile, contents, { encoding: 'utf-8', mode: 0o600 })
  return applySecurePathRestriction(tmpFile, false, process.platform, true) === 'applied'
}

function fsyncPathSync(path: string, flags: 'r' | 'r+'): void {
  const descriptor = openSync(path, flags)
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function fsyncFileSync(path: string): void {
  // FlushFileBuffers requires a write-capable handle on Windows.
  fsyncPathSync(path, process.platform === 'win32' ? 'r+' : 'r')
}

export function bestEffortFsyncDirectorySync(directory: string): void {
  if (process.platform === 'win32') {
    return
  }
  try {
    fsyncPathSync(directory, 'r')
  } catch (error) {
    if (
      error instanceof Error &&
      UNSUPPORTED_DIRECTORY_FSYNC_CODES.has((error as NodeJS.ErrnoException).code ?? '')
    ) {
      return
    }
    throw error
  }
}

/**
 * Errors that mean the contents were never seen, so they say nothing about what the file holds.
 *
 * `ENOENT` is deliberately absent: "there is no file" genuinely licenses creating one. So is a
 * parse failure, which means the bytes WERE read and were garbage - the self-heal these stores
 * were built for. The distinction is "could not read it" versus "read it and it was garbage".
 *
 * Why it matters: a reader that treats every failure as corruption regenerates the file, and the
 * regeneration succeeds - `renameSync` over an unreadable file needs `FILE_DELETE_CHILD` on the
 * parent, not `DELETE` on the file - so the original is destroyed by the code meant to heal it.
 * `EPERM`/`EACCES` is the hardened-DACL case: a file granting a SID this process does not hold,
 * reachable through a relocated user-data path, a share or roaming profile, a restored backup
 * under a new local SID, or a half-applied harden. The rest are transient and, on Windows, more
 * likely than that: `EBUSY` is what antivirus produces by holding a file open at the moment of a
 * read, which for a credential read on the startup path is an ordinary Tuesday.
 */
export function isUnreadableError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return (
    code === 'EPERM' ||
    code === 'EACCES' ||
    code === 'EBUSY' ||
    code === 'EMFILE' ||
    code === 'ENFILE' ||
    code === 'EIO'
  )
}

export function hardenExistingSecureFile(targetPath: string): void {
  const dir = dirname(targetPath)
  if (existsSync(dir)) {
    hardenSecurePathOnce(dir, true)
  }
  if (existsSync(targetPath)) {
    hardenSecurePathOnce(targetPath, false)
  }
}

/** Applies the platform-appropriate permission restriction to a path once, bypassing the cache. */
export function hardenSecurePath(
  targetPath: string,
  options: {
    isDirectory: boolean
    platform: NodeJS.Platform
    sync?: boolean
  }
): void {
  applySecurePathRestriction(
    targetPath,
    options.isDirectory,
    options.platform,
    options.sync ?? false
  )
}

/**
 * `pending` is the honest answer for the async Windows branch: it has not happened yet, and
 * reporting it as `applied` is what let a dead ACL look like a working one. The real outcome
 * arrives through `onAsyncSettled`.
 */
type HardeningOutcome = 'applied' | 'pending' | 'failed'

function applySecurePathRestriction(
  targetPath: string,
  isDirectory: boolean,
  platform: NodeJS.Platform,
  sync: boolean,
  onAsyncSettled?: (restricted: boolean) => void
): HardeningOutcome {
  if (platform === 'win32') {
    if (sync) {
      // Why no retry floor here: callers are user-driven or startup-only, not polled.
      const restricted = restrictWindowsPathSync(targetPath, isDirectory)
      if (restricted) {
        // Success only: this is how a recovered host clears the read path's backoff (and reports
        // `recovered`). Recording a failure here would put the exempt lane back under the budget.
        recordHardeningOutcome(targetPath, true)
      }
      return restricted ? 'applied' : 'failed'
    }
    // Why the floor: this is the read path, polled at ~2/s (#4901). Retrying every failure there
    // is the same storm the cache exists to prevent.
    if (!mayAttemptHardening(targetPath)) {
      onAsyncSettled?.(false)
      return 'failed'
    }
    // Why async: a directory rewrite walks every descendant, and read paths poll (#4901).
    bestEffortRestrictWindowsPath(targetPath, isDirectory, (restricted) => {
      recordHardeningOutcome(targetPath, restricted)
      onAsyncSettled?.(restricted)
    })
    return 'pending'
  }
  chmodSync(targetPath, isDirectory ? 0o700 : 0o600)
  return 'applied'
}

/** Caches the current metadata snapshot for a just-hardened path, or clears it if the path is gone. */
function rememberHardenedPath(targetPath: string, isDirectory: boolean): void {
  const entry = getHardenedPathCacheEntry(targetPath, isDirectory)
  if (entry) {
    hardenedPathsThisProcess.set(targetPath, entry)
  } else {
    hardenedPathsThisProcess.delete(targetPath)
  }
}

export function __resetSecureFileWindowsUserSidForTests(): void {
  resetSecureFileWindowsUserSidForTests()
}

export function __resetSecureFileHardenedPathsForTests(
  bounds: SecurePathHardeningCacheBounds = DEFAULT_HARDENING_CACHE_BOUNDS
): void {
  hardenedPathsThisProcess = new SecurePathHardeningCache(bounds)
  hardenedDirectoryPathsThisProcess = new SecurePathHardeningCache(bounds)
  configureHardeningRetryBudget(bounds)
}

export function __getSecureFileHardeningCacheStateForTests(): {
  paths: ReturnType<SecurePathHardeningCache<HardenedPathCacheEntry>['state']>
  directories: ReturnType<SecurePathHardeningCache<true>['state']>
} {
  return {
    paths: hardenedPathsThisProcess.state(),
    directories: hardenedDirectoryPathsThisProcess.state()
  }
}
