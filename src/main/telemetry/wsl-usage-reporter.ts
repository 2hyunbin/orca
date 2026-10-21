// Windows-only, at-most-daily `wsl_usage_snapshot`. Cost per send: one native registry read,
// one `reg.exe` Lxss query, and a `wsl --list --running` only when no confirmed running list is
// cached yet and a user distro exists. Nothing is gathered while telemetry is off.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Store } from '../persistence'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { isWslHostRuntimeEnvironment } from '../../shared/runtime-environments'
import { resolveLocalWorkspaceRuntime } from '../local-project-runtime-resolution'
import { getCachedWslAvailability } from '../wsl-availability'
import { listConfirmedRunningWslDistros } from '../wsl-background-distro-gate'
import { filterUserWslDistros } from '../wsl-distro-list-output'
import { peekConfirmedRunningWslDistros } from '../wsl-running-distro-cache'
import { loadWindowsNativeRegistry, WINDOWS_REG_SZ } from '../windows-native-registry'
import { readWslDistroRegistrations } from '../wsl/wsl-distro-registry-id'
import { listWslHostDistros } from '../wsl/wsl-host-distro-list'
import { wslHostsGateOpen } from '../wsl/wsl-host-gate'
import { isTelemetryEnabled, track } from './client'
import {
  buildWslUsageSnapshot,
  classifyLocalWslProject,
  classifyWslHostProject,
  type WslUsageProject,
  type WslUsageSnapshotInput
} from './wsl-usage-snapshot'

export const WSL_USAGE_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000
// Only a timestamp compare per tick; the gather runs at most once per interval.
const RECHECK_MS = 60 * 60 * 1000
const STAMP_FILE = 'wsl-usage-telemetry.json'
const WSL_MSI_KEY = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Lxss\\MSI'

/** The WSL package version the MSI installer records; null for inbox/Store WSL or no addon. */
function readWslPackageVersion(): string | null {
  try {
    const registry = loadWindowsNativeRegistry()
    const entry = Object.entries(registry.getRegistryKey(registry.HK.LM, WSL_MSI_KEY) ?? {}).find(
      ([name]) => name.toLowerCase() === 'version'
    )?.[1]
    return entry?.type === WINDOWS_REG_SZ && typeof entry.value === 'string' ? entry.value : null
  } catch {
    return null
  }
}

function collectWslProjects(
  store: Store,
  userDataPath: string,
  gateOpen: boolean
): WslUsageProject[] {
  const projects: WslUsageProject[] = []
  let wslHostDistroByEnvironment: Map<string, string> | null = null
  for (const repo of store.getRepos()) {
    const host = parseExecutionHostId(getRepoExecutionHostId(repo))
    if (!host || host.kind === 'local') {
      const project = classifyLocalWslProject(
        repo,
        resolveLocalWorkspaceRuntime(store, repo, repo.path)
      )
      if (project) {
        projects.push(project)
      }
      continue
    }
    // Gated-off WSL hosts are never listed or reached, so they don't count as usage either.
    if (host.kind !== 'runtime' || !gateOpen) {
      continue
    }
    wslHostDistroByEnvironment ??= readWslHostDistros(userDataPath)
    const distro = wslHostDistroByEnvironment.get(host.environmentId)
    if (distro) {
      projects.push(classifyWslHostProject(repo, distro))
    }
  }
  return projects
}

function readWslHostDistros(userDataPath: string): Map<string, string> {
  try {
    return new Map(
      listEnvironments(userDataPath)
        .filter(isWslHostRuntimeEnvironment)
        .map((environment) => [environment.id, environment.orcadDeployment.distro])
    )
  } catch {
    return new Map()
  }
}

export async function gatherWslUsageSnapshotInput(
  store: Store,
  userDataPath: string
): Promise<WslUsageSnapshotInput> {
  const gateOpen = wslHostsGateOpen()
  const registrations = await readWslDistroRegistrations()
  const userDistros = await listWslHostDistros({
    readRegistrations: async () => registrations,
    // Reuse a confirmed list; otherwise one shared probe, and none when no user distro exists.
    listRunning: async () => {
      const cached = peekConfirmedRunningWslDistros()
      if (cached) {
        return [...cached]
      }
      const userNames = filterUserWslDistros((registrations ?? []).map(({ distro }) => distro))
      return userNames.length > 0 ? listConfirmedRunningWslDistros() : []
    }
  })
  return {
    registeredDistroCount: registrations?.length ?? null,
    userDistros,
    wslPackageVersion: readWslPackageVersion(),
    wslAvailableCached: getCachedWslAvailability(),
    projects: collectWslProjects(store, userDataPath, gateOpen),
    wslHostsGateOpen: gateOpen
  }
}

async function readLastSentAt(file: string): Promise<number | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    const value =
      parsed && typeof parsed === 'object' && 'lastSentAt' in parsed ? parsed.lastSentAt : null
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

export type WslUsageReporterDeps = {
  now?: () => number
  platform?: NodeJS.Platform
  telemetryEnabled?: () => boolean
  gather?: () => Promise<WslUsageSnapshotInput>
}

export class WslUsageReporter {
  private lastSentAt: number | null | undefined
  private running = false
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly stampFile: string

  constructor(
    private readonly store: Store,
    private readonly userDataPath: string,
    private readonly deps: WslUsageReporterDeps = {}
  ) {
    this.stampFile = join(userDataPath, STAMP_FILE)
  }

  start(): void {
    if ((this.deps.platform ?? process.platform) !== 'win32' || this.timer) {
      return
    }
    void this.reportIfDue()
    this.timer = setInterval(() => void this.reportIfDue(), RECHECK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Returns whether a snapshot was sent. Never throws. */
  async reportIfDue(): Promise<boolean> {
    if ((this.deps.platform ?? process.platform) !== 'win32' || this.running) {
      return false
    }
    // Why before gathering: an opted-out install pays no registry or wsl.exe read at all.
    if (!(this.deps.telemetryEnabled ?? isTelemetryEnabled)()) {
      return false
    }
    this.running = true
    try {
      const now = (this.deps.now ?? Date.now)()
      if (this.lastSentAt === undefined) {
        this.lastSentAt = await readLastSentAt(this.stampFile)
      }
      if (this.lastSentAt !== null && now - this.lastSentAt < WSL_USAGE_SNAPSHOT_INTERVAL_MS) {
        return false
      }
      const input = await (
        this.deps.gather ?? (() => gatherWslUsageSnapshotInput(this.store, this.userDataPath))
      )()
      const sent = track('wsl_usage_snapshot', buildWslUsageSnapshot(input))
      // Stamp the attempt, not the send: a dropped payload must not re-pay the gather every hour.
      this.lastSentAt = now
      await writeFile(this.stampFile, JSON.stringify({ lastSentAt: now })).catch(() => {})
      return sent
    } catch (error) {
      console.warn('[telemetry] wsl usage snapshot failed:', error)
      return false
    } finally {
      this.running = false
    }
  }
}
