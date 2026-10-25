/**
 * Idle-time pack compaction. In a blob:none partial clone every lazy blob fetch writes a
 * tiny promisor pack, and Git's own auto-maintenance never merges them: its geometric
 * trigger (the 2.54+ default) ignores promisor packs. Unmerged, a checkout reaches
 * thousands of packs and second-long object lookups, so Orca counts packs itself.
 */

/** Git's default `gc.autoPackLimit`; promisor packs count too. */
export const OBJECT_PACK_COUNT_THRESHOLD = 50
/** Git's default `gc.auto`, estimated like Git does from one fan-out directory. */
export const LOOSE_OBJECT_THRESHOLD = 6_700

export const OBJECT_MAINTENANCE_COOLDOWN_MS = 60 * 60_000
export const OBJECT_MAINTENANCE_FAILURE_COOLDOWN_MS = 6 * 60 * 60_000

/** No live gc or maintenance runs this long; a lock this old with none running is a strand. */
export const MAINTENANCE_LOCK_STALE_MS = 6 * 60 * 60_000

/**
 * Explicit task, so worktree-prune and reflog-expire never run: a worktree on an
 * unmounted volume must not be pruned. `maintenance run` takes `objects/maintenance.lock`,
 * which keeps this exclusive with Git's own maintenance. Geometric repacking also packs
 * loose objects, and only merges promisor packs correctly from Git 2.53.
 */
export const OBJECT_MAINTENANCE_ARGS = [
  '-c',
  'maintenance.autoDetach=false',
  'maintenance',
  'run',
  '--task=geometric-repack',
  '--quiet'
] as const

export type ObjectMaintenanceOutcome =
  | 'ran'
  | 'below_threshold'
  | 'unsupported'
  | 'busy'
  | 'deferred'
  | 'failed'

export type ObjectStoreProbe = {
  /** `.pack` files seen, promisor packs included; a floor capped at the threshold. */
  packCount: number
  /** Estimated from one fan-out directory, as Git's own auto heuristic does. */
  looseObjects: number
}

export function isObjectMaintenanceDue(probe: ObjectStoreProbe): boolean {
  return (
    probe.packCount >= OBJECT_PACK_COUNT_THRESHOLD || probe.looseObjects >= LOOSE_OBJECT_THRESHOLD
  )
}

export function supportsPromisorGeometricRepack(gitVersionOutput: string): boolean {
  const match = /git version (\d+)\.(\d+)/.exec(gitVersionOutput)
  if (!match) {
    return false
  }
  const [major, minor] = [Number(match[1]), Number(match[2])]
  return major > 2 || (major === 2 && minor >= 53)
}

export type MaintenanceLockFacts = {
  ageMs: number
  /** Unknown (e.g. the process list could not be read) must be reported as true. */
  gitMaintenanceRunning: boolean
  /** Only for gc.pid: false when its pid is dead on this host or it names another host. */
  gcPidLive?: boolean
}

/** Git never expires these locks itself; a strand silently turns every later run into a no-op. */
export function isStaleMaintenanceLock(facts: MaintenanceLockFacts): boolean {
  return facts.ageMs > MAINTENANCE_LOCK_STALE_MS && !facts.gitMaintenanceRunning && !facts.gcPidLive
}

const GIT_MAINTENANCE_COMMAND =
  /(?:^|[\s/\\"])git(?:\.exe)?"?\s(?:.*\s)?(?:gc|maintenance|repack|pack-objects)(?:\s|$)|(?:^|[\s/\\"])git-(?:gc|repack|pack-objects)(?:\.exe)?(?:[\s"]|$)/i

/** Matches loosely on purpose: a false positive only delays removing a lock. */
export function isGitMaintenanceCommandLine(commandLine: string): boolean {
  return GIT_MAINTENANCE_COMMAND.test(commandLine)
}
