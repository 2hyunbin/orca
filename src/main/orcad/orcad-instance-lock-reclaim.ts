/**
 * Replacing a stale orcad instance lock without ever displacing a live one (see
 * `orcad-instance-lock.ts`).
 */
import { randomUUID } from 'node:crypto'
import {
  linkSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { OrcadInstanceLockError } from './orcad-data-root-privacy'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { hasErrorCode } from '../daemon/daemon-process-inspection'

export const MAX_ORCAD_LOCK_BYTES = 64 * 1024
// Serializes stale-lock recovery, so no reclaimer ever renames away a lock another just published.
const RECOVERY_DIR_SUFFIX = '.recovery'
const RECOVERY_OWNER_FILE = 'owner'
// Recovery takes milliseconds; a recovery lock older than this was left by a crash.
const RECOVERY_GRACE_MS = 10_000

/**
 * Why rename-and-then-publish rather than unlink-and-write: rename claims one exact directory
 * entry, so a replacement written between our read and our write stays at the canonical path
 * and wins — we never delete a record we did not inspect.
 */
export function reclaimAndPublish(
  lockPath: string,
  dataRoot: string,
  inspectedContents: string,
  publish: () => boolean
): void {
  return withRecoveryLock(lockPath, () => {
    // Another reclaimer finished first: whatever it published is authoritative, not stale.
    if (readBoundedLockFile(lockPath) !== inspectedContents) {
      throw new OrcadInstanceLockError(
        'orcad_instance_lock_held',
        `Another process took the data root ${dataRoot} while this one was reclaiming a stale lock.`
      )
    }
    renameAndPublish(lockPath, dataRoot, inspectedContents, publish)
  })
}

function renameAndPublish(
  lockPath: string,
  dataRoot: string,
  inspectedContents: string,
  publish: () => boolean
): void {
  const claimPath = `${lockPath}.stale-${process.pid}-${randomUUID()}`
  try {
    renameSync(lockPath, claimPath)
  } catch {
    throw new OrcadInstanceLockError(
      'orcad_instance_lock_held',
      `Could not reclaim the stale orcad instance lock at ${lockPath}; another process is ` +
        'holding it. Retry, or stop the other orcad.'
    )
  }
  // A contender may have replaced the entry after the liveness check; never displace its record.
  const claimedContents = readBoundedLockFile(claimPath)
  if (claimedContents !== inspectedContents) {
    restoreDisplacedLock(claimPath, lockPath, claimedContents)
    throw new OrcadInstanceLockError(
      'orcad_instance_lock_held',
      `The orcad instance lock at ${lockPath} changed while reclaiming a stale record.`
    )
  }
  const published = publish()
  // A uniquely named claim is inert either way.
  unlinkQuietly(claimPath)
  if (!published) {
    // Someone else claimed it first. Their record is authoritative; ours is not.
    throw new OrcadInstanceLockError(
      'orcad_instance_lock_held',
      `Another orcad took the data root ${dataRoot} while this one was reclaiming a stale lock.`
    )
  }
}

function withRecoveryLock<T>(lockPath: string, recover: () => T): T {
  const dir = `${lockPath}${RECOVERY_DIR_SUFFIX}`
  const nonce = randomUUID()
  if (
    !takeRecoveryLock(dir, nonce) &&
    !(breakAbandonedRecoveryLock(dir) && takeRecoveryLock(dir, nonce))
  ) {
    throw new OrcadInstanceLockError(
      'orcad_instance_lock_held',
      `Another process is reclaiming the stale orcad instance lock at ${lockPath}. Retry.`
    )
  }
  try {
    return recover()
  } finally {
    if (readBoundedLockFile(join(dir, RECOVERY_OWNER_FILE)) === nonce) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function takeRecoveryLock(dir: string, nonce: string): boolean {
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      return false
    }
    throw new OrcadInstanceLockError(
      'orcad_data_root_unusable',
      `Cannot create ${dir}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  try {
    writeFileSync(join(dir, RECOVERY_OWNER_FILE), nonce, { flag: 'wx', mode: 0o600 })
    return true
  } catch {
    rmSync(dir, { recursive: true, force: true })
    return false
  }
}

/**
 * Only a crash mid-recovery leaves this. Renamed aside and re-inspected, like the lock itself, so a
 * recovery lock a live reclaimer just took is put back rather than deleted.
 */
function breakAbandonedRecoveryLock(dir: string): boolean {
  const owner = join(dir, RECOVERY_OWNER_FILE)
  const inspected = readBoundedLockFile(owner)
  if (!recoveryLockIsAbandoned(dir)) {
    return false
  }
  const aside = `${dir}.abandoned-${process.pid}-${randomUUID()}`
  try {
    renameSync(dir, aside)
  } catch {
    return false
  }
  // A taker we displaced before it wrote its owner fails its own write, so null matching is safe.
  if (readBoundedLockFile(join(aside, RECOVERY_OWNER_FILE)) === inspected) {
    rmSync(aside, { recursive: true, force: true })
    return true
  }
  try {
    // Fails onto a newer, non-empty recovery lock, which then stays authoritative.
    renameSync(aside, dir)
  } catch {
    // Left aside under a unique name; inert.
  }
  return false
}

function recoveryLockIsAbandoned(dir: string): boolean {
  try {
    return Date.now() - statSync(dir).mtimeMs > RECOVERY_GRACE_MS
  } catch {
    return false
  }
}

/** No-clobber restore: a third contender's newer record at the canonical path stays authoritative. */
function restoreDisplacedLock(
  claimPath: string,
  lockPath: string,
  claimedContents: string | null
): void {
  try {
    linkSync(claimPath, lockPath)
    unlinkSync(claimPath)
  } catch {
    if (claimedContents === null) {
      return
    }
    try {
      writeFileSync(lockPath, claimedContents, { flag: 'wx', mode: 0o600 })
      unlinkSync(claimPath)
    } catch {
      // A newer contender won, or restoration is unavailable; fail closed.
    }
  }
}

export function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Already gone, or inert under its unique name.
  }
}

export function readBoundedLockFile(path: string): string | null {
  try {
    const { buffer, stats } = readNodeFileSyncWithinLimit(path, MAX_ORCAD_LOCK_BYTES)
    return stats.isFile() ? buffer.toString('utf8') : null
  } catch {
    return null
  }
}
