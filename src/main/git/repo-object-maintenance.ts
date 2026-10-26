import { opendir } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import {
  isObjectMaintenanceDue,
  LOOSE_OBJECT_THRESHOLD,
  OBJECT_MAINTENANCE_ARGS,
  OBJECT_PACK_COUNT_THRESHOLD,
  supportsPromisorGeometricRepack,
  type ObjectMaintenanceOutcome,
  type ObjectStoreProbe
} from '../../shared/repo-object-maintenance-policy'
import type { RefMaintenanceSpan } from '../../shared/repo-ref-maintenance-policy'
import { readHostGitVersion } from './git-version'
import { isRepoMaintenanceLocked } from './repo-maintenance-locks'
import { gitExecFileAsync } from './runner'

/** Git samples fan-out directory 17 and scales by 256 for its auto-gc estimate. */
const LOOSE_SAMPLE_DIRECTORY = '17'
const LOOSE_OBJECT_NAME = /^[0-9a-f]{38}(?:[0-9a-f]{24})?$/

async function countObjectFiles(
  directory: string,
  signal: AbortSignal,
  threshold: number,
  matches: (name: string) => boolean
): Promise<number> {
  if (signal.aborted) {
    return 0
  }
  const entries = await opendir(directory).catch(() => null)
  let count = 0
  for await (const entry of entries ?? []) {
    if (matches(entry.name)) {
      count += 1
    }
    if (count >= threshold || signal.aborted) {
      break
    }
  }
  return count
}

export async function probeRepoObjectStore(
  commonDir: string,
  signal: AbortSignal
): Promise<ObjectStoreProbe> {
  const paths = isWindowsAbsolutePathLike(commonDir) ? win32 : posix
  const objects = paths.join(commonDir, 'objects')
  const [packCount, looseCount] = await Promise.all([
    countObjectFiles(paths.join(objects, 'pack'), signal, OBJECT_PACK_COUNT_THRESHOLD, (name) =>
      name.endsWith('.pack')
    ),
    countObjectFiles(
      paths.join(objects, LOOSE_SAMPLE_DIRECTORY),
      signal,
      Math.ceil(LOOSE_OBJECT_THRESHOLD / 256),
      (name) => LOOSE_OBJECT_NAME.test(name)
    )
  ])
  return {
    packCount,
    looseObjects: looseCount * 256
  }
}

type RepoObjectMaintenanceArgs = {
  repoPath: string
  /** Common directory in the spelling the main process can open. */
  commonDir: string
  wslDistro?: string
  signal: AbortSignal
  span: RefMaintenanceSpan
  canWrite: () => boolean
}

export async function maintainRepoObjects(
  args: RepoObjectMaintenanceArgs
): Promise<ObjectMaintenanceOutcome> {
  const { signal, span } = args
  const gitOptions = {
    cwd: args.repoPath,
    ...(args.wslDistro ? { wslDistro: args.wslDistro } : {}),
    admissionTier: 'background' as const
  }
  let started = false
  try {
    if (signal.aborted || !args.canWrite()) {
      return 'deferred'
    }
    const probe = await probeRepoObjectStore(args.commonDir, signal)
    span.setAttribute('git.pack_count_floor', probe.packCount)
    span.setAttribute('git.loose_object_estimate_floor', probe.looseObjects)
    if (signal.aborted || !args.canWrite()) {
      return 'deferred'
    }
    if (!isObjectMaintenanceDue(probe)) {
      return 'below_threshold'
    }
    if (await isRepoMaintenanceLocked(args.commonDir)) {
      return 'busy'
    }
    if (!supportsPromisorGeometricRepack(await readHostGitVersion(args.repoPath, args.wslDistro))) {
      return 'unsupported'
    }
    const startedAt = Date.now()
    // No timeout and no kill signal: interrupting a repack wastes it, so only admission cancels.
    await gitExecFileAsync([...OBJECT_MAINTENANCE_ARGS], {
      ...gitOptions,
      admissionSignal: signal,
      lowPriority: true,
      maintenancePhase: 'objects',
      canStart: () => (started = args.canWrite())
    })
    span.setAttribute('git.object_maintenance_ms', Date.now() - startedAt)
    return 'ran'
  } catch (error) {
    // A run that started and failed is the repo's problem, not a yield to user activity.
    if (!started && (signal.aborted || !args.canWrite())) {
      return 'deferred'
    }
    span.setAttribute('git.object_maintenance_error', String(error))
    return 'failed'
  }
}
