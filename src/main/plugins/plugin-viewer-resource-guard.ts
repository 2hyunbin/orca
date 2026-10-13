import {
  PLUGIN_VIEWER_RESOURCE_SAMPLE_MS,
  PLUGIN_VIEWER_RESIDENT_BYTES,
  PLUGIN_VIEWER_AGGREGATE_RESIDENT_BYTES,
  PLUGIN_VIEWER_CPU_WINDOW_MS,
  PLUGIN_VIEWER_CPU_SECONDS,
  PLUGIN_VIEWER_AGGREGATE_CPU_SECONDS
} from '../../shared/plugins/plugin-viewer-resource-limits'
import { PLUGIN_VIEWER_SESSION_LIMIT } from '../../shared/plugins/plugin-viewer-document'
import {
  exclusivePluginViewerFrames,
  pluginViewerFrameIdentity,
  type PluginViewerProcessMetric,
  type PluginViewerProcessOwner
} from './plugin-viewer-process-ownership'

type Failure = 'unauthorized' | 'unavailable' | 'limit_exceeded'
type Entry = {
  contentsId: number
  relayPid: number
  frameIdentity: string
  processes: ReadonlyMap<number, number>
  history: { at: number; cpu: number }[]
  last?: { at: number; cpu: number }
  resident: number
  cpu: number
  fail(reason: Failure): void
}
type Dependencies = {
  owners(): readonly PluginViewerProcessOwner[]
  metrics(): readonly PluginViewerProcessMetric[]
  now(): number
  terminate(pid: number): void
}

/** Samples whole renderer processes, including worker threads and backing buffers. */
export class PluginViewerResourceGuard {
  private readonly entries = new Map<string, Entry>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(private readonly dependencies: Dependencies) {}

  admit(id: string, contentsId: number, fail: Entry['fail'], relayPid: number): boolean {
    if (this.disposed) {
      fail('unavailable')
      return false
    }
    if (
      this.entries.has(id) ||
      [...this.entries.values()].some((entry) => entry.contentsId === contentsId) ||
      this.entries.size >= PLUGIN_VIEWER_SESSION_LIMIT
    ) {
      fail('limit_exceeded')
      return false
    }
    try {
      const frames = exclusivePluginViewerFrames(contentsId, this.dependencies.owners(), true)
      const metrics = this.dependencies.metrics()
      const processes = new Map<number, number>()
      for (const pid of new Set(frames?.map((frame) => frame.pid))) {
        const metric = metrics.find((candidate) => candidate.pid === pid)
        if (!metric || !this.validMetric(metric)) {
          fail('unavailable')
          return false
        }
        processes.set(pid, metric.creationTime)
      }
      if (!frames || frames.length > 2 || !processes.size || !processes.has(relayPid)) {
        fail('unauthorized')
        return false
      }
      this.entries.set(id, {
        contentsId,
        relayPid,
        frameIdentity: pluginViewerFrameIdentity(frames),
        processes,
        history: [],
        resident: 0,
        cpu: 0,
        fail
      })
      this.sample()
      this.schedule()
      return this.entries.has(id)
    } catch {
      this.reject(id, 'unavailable', fail)
      return false
    }
  }

  isCurrent(id: string, requireKnownPeers = false): boolean {
    const entry = this.entries.get(id)
    if (!entry) {
      return false
    }
    try {
      const frames = exclusivePluginViewerFrames(
        entry.contentsId,
        this.dependencies.owners(),
        requireKnownPeers
      )
      return Boolean(frames && pluginViewerFrameIdentity(frames) === entry.frameIdentity)
    } catch {
      return false
    }
  }

  release(id: string): void {
    this.entries.delete(id)
    if (!this.entries.size) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  terminateChildren(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) {
      return false
    }
    this.release(id)
    return this.terminateEntryChildren(entry)
  }

  private terminateEntryChildren(entry: Entry): boolean {
    try {
      const children = [...entry.processes.keys()].filter((pid) => pid !== entry.relayPid)
      const current = (): boolean => {
        const frames = exclusivePluginViewerFrames(
          entry.contentsId,
          this.dependencies.owners(),
          true
        )
        const metrics = this.dependencies.metrics()
        return Boolean(
          frames &&
          pluginViewerFrameIdentity(frames) === entry.frameIdentity &&
          [...entry.processes].every(([ownedPid, creationTime]) =>
            metrics.some(
              (metric) =>
                metric.pid === ownedPid &&
                metric.creationTime === creationTime &&
                this.validMetric(metric)
            )
          )
        )
      }
      if (!current()) {
        return false
      }
      for (const pid of children) {
        if (!current()) {
          return false
        }
        this.dependencies.terminate(pid)
      }
      return true
    } catch {
      return false
    }
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
    this.timer = undefined
    this.entries.clear()
  }

  private schedule(): void {
    if (!this.entries.size || this.timer !== undefined) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.sample()
      this.schedule()
    }, PLUGIN_VIEWER_RESOURCE_SAMPLE_MS)
    this.timer.unref?.()
  }

  private sample(): void {
    try {
      const owners = this.dependencies.owners()
      const metrics = this.dependencies.metrics()
      const at = this.dependencies.now()
      for (const [id, entry] of this.entries) {
        const frames = exclusivePluginViewerFrames(entry.contentsId, owners)
        if (!frames || pluginViewerFrameIdentity(frames) !== entry.frameIdentity) {
          this.reject(id, 'unauthorized')
          continue
        }
        let resident = 0
        let cpu = 0
        let valid = Number.isFinite(at)
        for (const [pid, creationTime] of entry.processes) {
          const metric = metrics.find((candidate) => candidate.pid === pid)
          if (!metric || metric.creationTime !== creationTime || !this.validMetric(metric)) {
            valid = false
            break
          }
          resident += metric.residentBytes
          cpu += metric.cpuSeconds ?? 0
        }
        valid = valid && Number.isFinite(resident) && Number.isFinite(cpu)
        const previous = entry.last
        if (!valid || (previous && (at < previous.at || cpu < previous.cpu))) {
          this.reject(id, 'unavailable')
          continue
        }
        if (previous && at - previous.at > PLUGIN_VIEWER_CPU_WINDOW_MS) {
          entry.history = []
        }
        entry.last = { at, cpu }
        const lastSample = entry.history.at(-1)
        if (!lastSample || at - lastSample.at >= PLUGIN_VIEWER_RESOURCE_SAMPLE_MS) {
          entry.history.push({ at, cpu })
        }
        while (
          entry.history.length > 1 &&
          entry.history[1].at <= at - PLUGIN_VIEWER_CPU_WINDOW_MS
        ) {
          entry.history.shift()
        }
        entry.resident = resident
        entry.cpu = cpu - entry.history[0].cpu
        if (resident > PLUGIN_VIEWER_RESIDENT_BYTES || entry.cpu > PLUGIN_VIEWER_CPU_SECONDS) {
          this.reject(id, 'limit_exceeded')
        }
      }
      this.enforceAggregate('resident', PLUGIN_VIEWER_AGGREGATE_RESIDENT_BYTES)
      this.enforceAggregate('cpu', PLUGIN_VIEWER_AGGREGATE_CPU_SECONDS)
    } catch {
      for (const id of Array.from(this.entries.keys())) {
        this.reject(id, 'unavailable')
      }
    }
  }

  private enforceAggregate(key: 'resident' | 'cpu', limit: number): void {
    const largest = Array.from(this.entries)
      .toReversed()
      .sort((a, b) => b[1][key] - a[1][key])
    let total = largest.reduce((sum, [, entry]) => sum + entry[key], 0)
    for (const [id, entry] of largest) {
      if (total <= limit) {
        return
      }
      total -= entry[key]
      this.reject(id, 'limit_exceeded')
    }
  }

  private validMetric(metric: PluginViewerProcessMetric): boolean {
    return (
      metric.type === 'Tab' &&
      Number.isFinite(metric.creationTime) &&
      metric.creationTime > 0 &&
      Number.isSafeInteger(metric.residentBytes) &&
      metric.residentBytes >= 0 &&
      metric.cpuSeconds !== undefined &&
      Number.isFinite(metric.cpuSeconds) &&
      metric.cpuSeconds >= 0
    )
  }

  private reject(id: string, reason: Failure, fallback?: Entry['fail']): void {
    const entry = this.entries.get(id)
    const fail = entry?.fail ?? fallback
    this.release(id)
    if (entry && reason === 'limit_exceeded') {
      this.terminateEntryChildren(entry)
    }
    fail?.(reason)
  }
}
