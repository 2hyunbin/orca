import { opendir, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import type { RepoMaintenanceConfig } from '../../shared/repo-maintenance-config'
import {
  isObjectMaintenanceDue,
  OBJECT_BACKLOG_PACK_COUNT,
  objectMaintenanceArgs,
  planObjectMaintenance,
  type ObjectMaintenanceOutcome,
  type ObjectStoreProbe
} from '../../shared/repo-object-maintenance-policy'
import type { RefMaintenanceSpan } from '../../shared/repo-ref-maintenance-policy'
import { isWslUncPath } from '../../shared/wsl-paths'
import { readHostGitVersion } from './git-version'
import { inspectRepoGcLocks } from './repo-gc-lock-diagnostics'
import { PACK_INDEX_PROBE_ENTRY_LIMIT, PACK_INDEX_PROBE_TIMEOUT_MS } from './repo-pack-index-state'
import { gitExecFileAsync } from './runner'

const IS_NEEDED_TIMEOUT_MS = 60_000
/** Git samples fan-out directory 17 and scales by 256 for its auto-gc estimate. */
const LOOSE_SAMPLE_DIRECTORY = '17'
const LOOSE_OBJECT_NAME = /^[0-9a-f]{38}(?:[0-9a-f]{24})?$/

async function countPacks(directory: string, signal: AbortSignal): Promise<number> {
  const entries = await opendir(directory).catch(() => null)
  if (!entries) {
    return 0
  }
  const startedAt = Date.now()
  let visited = 0
  let packs = 0
  for await (const entry of entries) {
    if (entry.name.endsWith('.pack') && entry.name.startsWith('pack-')) {
      packs += 1
    }
    visited += 1
    if (
      packs >= OBJECT_BACKLOG_PACK_COUNT ||
      signal.aborted ||
      visited >= PACK_INDEX_PROBE_ENTRY_LIMIT ||
      Date.now() - startedAt >= PACK_INDEX_PROBE_TIMEOUT_MS
    ) {
      break
    }
  }
  return packs
}

async function sampleLooseObjects(
  directory: string,
  signal: AbortSignal
): Promise<Pick<ObjectStoreProbe, 'looseObjects' | 'looseBytes'>> {
  const entries = await opendir(directory).catch(() => null)
  if (!entries) {
    return { looseObjects: 0, looseBytes: 0 }
  }
  const paths = isWindowsAbsolutePathLike(directory) ? win32 : posix
  let objects = 0
  let bytes = 0
  for await (const entry of entries) {
    if (signal.aborted || objects >= PACK_INDEX_PROBE_ENTRY_LIMIT) {
      break
    }
    if (LOOSE_OBJECT_NAME.test(entry.name)) {
      objects += 1
      bytes += await stat(paths.join(directory, entry.name)).then(
        (info) => info.size,
        () => 0
      )
    }
  }
  return { looseObjects: objects * 256, looseBytes: bytes * 256 }
}

export async function probeRepoObjectStore(
  commonDir: string,
  signal: AbortSignal
): Promise<ObjectStoreProbe> {
  const paths = isWindowsAbsolutePathLike(commonDir) ? win32 : posix
  const objects = paths.join(commonDir, 'objects')
  const [packCount, loose] = await Promise.all([
    countPacks(paths.join(objects, 'pack'), signal),
    sampleLooseObjects(paths.join(objects, LOOSE_SAMPLE_DIRECTORY), signal)
  ])
  return { packCount, ...loose }
}

type RepoObjectMaintenanceArgs = {
  repoPath: string
  /** Common directory in the spelling the main process can open. */
  commonDir: string
  wslDistro?: string
  config: RepoMaintenanceConfig
  signal: AbortSignal
  span: RefMaintenanceSpan
  canWrite: () => boolean
  /** True when a huge first catch-up may start: on AC, no live agents, user away. */
  canRunBacklog: () => boolean
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
    const locks = await inspectRepoGcLocks(args.commonDir, {
      canProbePids: !args.wslDistro && !isWslUncPath(args.commonDir)
    })
    span.setAttribute('git.gc_pid', locks.gcPid)
    span.setAttribute('git.gc_log_stale_bytes', locks.staleGcLogBytes)
    span.setAttribute('git.gc_log_lock_removed', locks.removedStaleGcLogLock)
    if (locks.gcPid === 'live') {
      return 'busy'
    }
    const probe = await probeRepoObjectStore(args.commonDir, signal)
    span.setAttribute('git.pack_count_floor', probe.packCount)
    span.setAttribute('git.loose_object_estimate', probe.looseObjects)
    span.setAttribute('git.loose_bytes_estimate', probe.looseBytes)
    if (signal.aborted || !args.canWrite()) {
      return 'deferred'
    }
    if (!isObjectMaintenanceDue(probe)) {
      return 'below_threshold'
    }
    const version = await readHostGitVersion(args.repoPath, args.wslDistro)
    if (!version) {
      return 'failed'
    }
    const plan = planObjectMaintenance({
      version,
      partialClone: args.config.partialClone,
      disabledTasks: args.config.disabledTasks,
      probe
    })
    if (plan.kind === 'skip') {
      return plan.reason
    }
    span.setAttribute('git.object_maintenance_tasks', plan.tasks.join(','))
    if (plan.backlog && !args.canRunBacklog()) {
      return 'backlog_deferred'
    }
    if (plan.confirmGeometric && !(await isGeometricRepackNeeded(gitOptions, signal))) {
      return 'below_threshold'
    }
    if (signal.aborted || !args.canWrite()) {
      return 'deferred'
    }
    const startedAt = Date.now()
    // No timeout and no kill signal: interrupting a repack wastes it, so only admission cancels.
    await gitExecFileAsync(objectMaintenanceArgs(plan.tasks), {
      ...gitOptions,
      admissionSignal: signal,
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

/** Exit 0 means due and 1 means not; anything else is not evidence, so run anyway. */
async function isGeometricRepackNeeded(
  gitOptions: { cwd: string; wslDistro?: string; admissionTier: 'background' },
  signal: AbortSignal
): Promise<boolean> {
  try {
    await gitExecFileAsync(['maintenance', 'is-needed', '--auto', '--task=geometric-repack'], {
      ...gitOptions,
      signal,
      timeout: IS_NEEDED_TIMEOUT_MS
    })
    return true
  } catch (error) {
    return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 1)
  }
}
