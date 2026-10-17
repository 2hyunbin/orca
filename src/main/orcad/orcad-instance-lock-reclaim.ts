/**
 * Replacing a stale orcad instance lock without ever displacing a live one (see
 * `orcad-instance-lock.ts`).
 */
import { randomUUID } from 'node:crypto'
import {
  linkSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { OrcadInstanceLockError } from './orcad-data-root-privacy'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'

export const MAX_ORCAD_LOCK_BYTES = 64 * 1024
// Serializes stale-lock recovery, so no reclaimer ever renames away a lock another just published.
const RECOVERY_DIR_SUFFIX = '.recovery'
const RECOVERY_OWNER_FILE = 'owner'

/** Who is recovering, as a lock record, and whether a recovery owner's holder provably exited. */
export type OrcadLockRecoveryOwner = {
  record: string
  exited: (ownerRecord: string) => boolean
}

/**
 * Why rename-and-then-publish rather than unlink-and-write: rename claims one exact directory
 * entry, so a replacement written between our read and our write stays at the canonical path
 * and wins — we never delete a record we did not inspect.
 */
export function reclaimAndPublish(
  lockPath: string,
  dataRoot: string,
  inspectedContents: string,
  publish: () => boolean,
  owner: OrcadLockRecoveryOwner
): void {
  return withRecoveryLock(lockPath, owner, () => {
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

function withRecoveryLock<T>(lockPath: string, owner: OrcadLockRecoveryOwner, recover: () => T): T {
  const dir = `${lockPath}${RECOVERY_DIR_SUFFIX}`
  if (
    !takeRecoveryLock(dir, owner.record) &&
    !(breakAbandonedRecoveryLock(dir, owner.exited) && takeRecoveryLock(dir, owner.record))
  ) {
    throw new OrcadInstanceLockError(
      'orcad_instance_lock_held',
      `Another process is reclaiming the stale orcad instance lock at ${lockPath}. Retry.`
    )
  }
  try {
    return recover()
  } finally {
    if (readBoundedLockFile(join(dir, RECOVERY_OWNER_FILE)) === owner.record) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/**
 * Staged with its owner, then renamed into place: the recovery lock never exists without a complete
 * owner, and a rename onto one that does (a non-empty directory) fails instead of replacing it.
 */
function takeRecoveryLock(dir: string, ownerRecord: string): boolean {
  const staged = `${dir}.staged-${process.pid}-${randomUUID()}`
  try {
    mkdirSync(staged, { mode: 0o700 })
    writeFileSync(join(staged, RECOVERY_OWNER_FILE), ownerRecord, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    rmSync(staged, { recursive: true, force: true })
    throw new OrcadInstanceLockError(
      'orcad_data_root_unusable',
      `Cannot create ${staged}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  try {
    renameSync(staged, dir)
    return true
  } catch {
    // Whatever holds the name, it was not created by this attempt; only our staging is removed.
    rmSync(staged, { recursive: true, force: true })
    return false
  }
}

/**
 * Only a crash mid-recovery leaves this, so it is broken only once its owner provably exited: a
 * paused owner (stalled NFS, a suspended laptop) still holds it however long ago it started.
 * Renamed aside and re-inspected, like the lock itself, so one a live reclaimer just took is put back.
 */
function breakAbandonedRecoveryLock(
  dir: string,
  exited: (ownerRecord: string) => boolean
): boolean {
  const inspected = readBoundedLockFile(join(dir, RECOVERY_OWNER_FILE))
  if (inspected === null) {
    // No lock is ever published without its owner; an empty directory is not one. rmdir refuses
    // a non-empty one, so a lock renamed into its place survives.
    try {
      rmdirSync(dir)
    } catch {
      return false
    }
    return true
  }
  if (!exited(inspected)) {
    return false
  }
  const aside = `${dir}.abandoned-${process.pid}-${randomUUID()}`
  try {
    renameSync(dir, aside)
  } catch {
    return false
  }
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
