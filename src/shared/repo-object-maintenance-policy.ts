/**
 * Idle-time pack and loose-object maintenance for repositories Orca degrades.
 *
 * Orca's fetches skip Git's auto-maintenance (`GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS`)
 * so hundreds of worktrees do not contend on auto-gc. Orca owns the replacement: in a
 * blob:none partial clone every lazy blob fetch writes a tiny promisor pack, and without
 * repacking a checkout reaches tens of thousands of packs and second-long object lookups.
 */

/** Git's default `gc.autoPackLimit`. The probe stops counting at the backlog bound. */
export const OBJECT_PACK_COUNT_THRESHOLD = 50
/** Git's default `gc.auto`, estimated like Git does from one fan-out directory. */
export const LOOSE_OBJECT_THRESHOLD = 6_700
/** A first catch-up this large waits for an idle, plugged-in, agent-free machine. */
export const OBJECT_BACKLOG_PACK_COUNT = 1_000
export const OBJECT_BACKLOG_LOOSE_BYTES = 2 * 1024 ** 3

export const OBJECT_MAINTENANCE_COOLDOWN_MS = 60 * 60_000
export const OBJECT_MAINTENANCE_FAILURE_COOLDOWN_MS = 6 * 60 * 60_000
export const OBJECT_MAINTENANCE_BACKLOG_RETRY_MS = 30 * 60_000

/** gc.pid older than this is stale even if the pid was reused, mirroring Git. */
export const GC_PID_STALE_MS = 12 * 60 * 60_000
/** Git's default `gc.logExpiry`; also the age at which a gc.log.lock is a strand. */
export const GC_LOG_STALE_MS = 24 * 60 * 60_000

export type ObjectMaintenanceOutcome =
  | 'ran'
  | 'below_threshold'
  | 'unsupported'
  | 'busy'
  | 'backlog_deferred'
  | 'deferred'
  | 'failed'

export type GitVersion = { major: number; minor: number; patch: number }

export function parseGitVersion(output: string): GitVersion | undefined {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output)
  if (!match) {
    return undefined
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0)
  }
}

export function isGitVersionAtLeast(version: GitVersion, major: number, minor: number): boolean {
  return version.major > major || (version.major === major && version.minor >= minor)
}

export type ObjectStoreProbe = {
  /** `.pack` files seen, capped at `OBJECT_BACKLOG_PACK_COUNT`. */
  packCount: number
  /** Estimated from one fan-out directory, as Git's own auto heuristic does. */
  looseObjects: number
  looseBytes: number
}

export type ObjectMaintenancePlan =
  | { kind: 'skip'; reason: 'below_threshold' | 'unsupported' }
  | {
      kind: 'run'
      tasks: readonly string[]
      backlog: boolean
      /**
       * Ask Git 2.54+ whether geometric repacking is due before paying for it. Never for a
       * partial clone: its estimate skips promisor packs, measured at "not needed" with 121.
       */
      confirmGeometric: boolean
    }

export type ObjectMaintenancePlanInput = {
  version: GitVersion
  partialClone: boolean
  disabledTasks: ReadonlySet<string>
  probe: ObjectStoreProbe
}

export function isObjectMaintenanceDue(probe: ObjectStoreProbe): boolean {
  return (
    probe.packCount >= OBJECT_PACK_COUNT_THRESHOLD || probe.looseObjects >= LOOSE_OBJECT_THRESHOLD
  )
}

export function planObjectMaintenance(input: ObjectMaintenancePlanInput): ObjectMaintenancePlan {
  const { probe, version } = input
  const looseDue = probe.looseObjects >= LOOSE_OBJECT_THRESHOLD
  if (!isObjectMaintenanceDue(probe)) {
    return { kind: 'skip', reason: 'below_threshold' }
  }
  // Explicit tasks keep worktree-prune and reflog-expire out: Orca owns worktree
  // lifecycle, and a worktree on an unmounted volume must never be pruned.
  let tasks: string[]
  if (isGitVersionAtLeast(version, 2, 53)) {
    tasks = ['loose-objects', 'geometric-repack', 'commit-graph']
  } else if (!isGitVersionAtLeast(version, 2, 30)) {
    return { kind: 'skip', reason: 'unsupported' }
  } else if (input.partialClone) {
    // incremental-repack predates promisor-aware repacking; the pack-index phase covers lookups.
    tasks = ['loose-objects', 'commit-graph']
  } else {
    tasks = ['loose-objects', 'incremental-repack', 'commit-graph']
  }
  tasks = tasks.filter((task) => !input.disabledTasks.has(task))
  if (tasks.length === 0) {
    return { kind: 'skip', reason: 'below_threshold' }
  }
  return {
    kind: 'run',
    tasks,
    backlog:
      probe.packCount >= OBJECT_BACKLOG_PACK_COUNT ||
      probe.looseBytes >= OBJECT_BACKLOG_LOOSE_BYTES,
    confirmGeometric:
      !looseDue &&
      !input.partialClone &&
      tasks.includes('geometric-repack') &&
      isGitVersionAtLeast(version, 2, 54)
  }
}

export function objectMaintenanceArgs(tasks: readonly string[]): string[] {
  return [
    '-c',
    'maintenance.autoDetach=false',
    'maintenance',
    'run',
    ...tasks.map((task) => `--task=${task}`),
    '--quiet'
  ]
}
