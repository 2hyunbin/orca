/** Config keys that decide whether, and which, idle maintenance Orca may run. */
export const REPO_MAINTENANCE_CONFIG_REGEXP =
  '^(gc\\.auto|maintenance\\.(strategy|repo|[a-z-]+\\.enabled)|extensions\\.partialclone|remote\\..+\\.promisor)$'

export type RepoMaintenanceConfigEntry = {
  /** Undefined when Git predates `--show-scope` (2.26). */
  scope?: string
  key: string
  value: string
}

export type RepoMaintenanceOptOut = 'gc_auto_disabled' | 'strategy_none' | 'external_scheduler'

export type RepoMaintenanceConfig = {
  optOut: RepoMaintenanceOptOut | null
  partialClone: boolean
  disabledTasks: ReadonlySet<string>
}

const SCOPES = new Set(['system', 'global', 'local', 'worktree', 'command'])

export function parseRepoMaintenanceConfig(output: string): RepoMaintenanceConfigEntry[] {
  const entries: RepoMaintenanceConfigEntry[] = []
  for (const raw of output.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line) {
      continue
    }
    const tab = line.indexOf('\t')
    const scope = tab > 0 && SCOPES.has(line.slice(0, tab)) ? line.slice(0, tab) : undefined
    const rest = scope ? line.slice(tab + 1) : line
    const space = rest.indexOf(' ')
    const key = (space === -1 ? rest : rest.slice(0, space)).toLowerCase()
    entries.push({
      scope,
      key,
      value: space === -1 ? '' : rest.slice(space + 1)
    })
  }
  return entries
}

function isFalse(value: string): boolean {
  return /^(?:false|no|off|0|)$/i.test(value.trim())
}

function isTrue(value: string): boolean {
  return /^(?:true|yes|on|1)$/i.test(value.trim())
}

function normalizeRepoPath(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(slashed) || slashed.startsWith('//') ? slashed.toLowerCase() : slashed
}

/**
 * `maintenance.auto=false` is not an opt-out: `git maintenance register` writes it so a
 * scheduler replaces auto-maintenance, and that registration is checked directly instead.
 * Per-command and system-wide `gc.auto=0` are not the user's choice for this repo either.
 */
export function readRepoMaintenanceConfig(
  entries: readonly RepoMaintenanceConfigEntry[],
  repoPaths: readonly string[]
): RepoMaintenanceConfig {
  // Orca injects per-command config into some git calls; that is never the user's setting.
  const persisted = entries.filter((entry) => entry.scope !== 'command')
  const last = (key: string): RepoMaintenanceConfigEntry | undefined =>
    persisted.findLast((entry) => entry.key === key)
  const gcAuto = last('gc.auto')
  const candidates = new Set(repoPaths.map(normalizeRepoPath))
  const registered = persisted.some(
    (entry) =>
      entry.key === 'maintenance.repo' &&
      (entry.scope === undefined || entry.scope === 'global') &&
      candidates.has(normalizeRepoPath(entry.value))
  )
  let optOut: RepoMaintenanceOptOut | null = null
  if (registered) {
    optOut = 'external_scheduler'
  } else if (last('maintenance.strategy')?.value.trim().toLowerCase() === 'none') {
    optOut = 'strategy_none'
  } else if (
    gcAuto &&
    gcAuto.scope !== 'system' &&
    /^\s*[+-]?0+(?:[kmg])?\s*$/i.test(gcAuto.value)
  ) {
    optOut = 'gc_auto_disabled'
  }
  const disabledTasks = new Set<string>()
  for (const entry of persisted) {
    const task = /^maintenance\.([a-z-]+)\.enabled$/.exec(entry.key)?.[1]
    if (task) {
      if (isFalse(entry.value)) {
        disabledTasks.add(task)
      } else {
        disabledTasks.delete(task)
      }
    }
  }
  const partialClone = persisted.some(
    (entry) =>
      (entry.key === 'extensions.partialclone' && entry.value.trim() !== '') ||
      (/^remote\..+\.promisor$/.test(entry.key) && isTrue(entry.value))
  )
  return { optOut, partialClone, disabledTasks }
}
