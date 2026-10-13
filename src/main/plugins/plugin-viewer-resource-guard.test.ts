import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginViewerResourceGuard } from './plugin-viewer-resource-guard'
import type {
  PluginViewerProcessOwner,
  PluginViewerProcessMetric
} from './plugin-viewer-process-ownership'
import { PLUGIN_VIEWER_RESOURCE_SAMPLE_MS } from '../../shared/plugins/plugin-viewer-resource-limits'

vi.mock('electron', () => ({ app: {}, webContents: {} }))
const mib = 1024 * 1024
const guards: PluginViewerResourceGuard[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  guards.splice(0).forEach((guard) => guard.dispose())
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
})

function fixture(count = 1) {
  let at = 0
  let owners: PluginViewerProcessOwner[] = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    valid: true,
    frames: [0, 1].map((offset) => ({
      frameId: index * 2 + offset,
      processId: index * 2 + offset + 1,
      pid: (index + 1) * 100 + offset
    }))
  }))
  const metrics: PluginViewerProcessMetric[] = owners.flatMap((owner) =>
    owner.frames.map((frame) => ({
      pid: frame.pid,
      creationTime: frame.pid,
      type: 'Tab',
      residentBytes: 150 * mib,
      cpuSeconds: 0
    }))
  )
  const terminate = vi.fn()
  const guard = new PluginViewerResourceGuard({
    owners: () => owners,
    metrics: () => metrics,
    now: () => at,
    terminate
  })
  guards.push(guard)
  const failures = Array.from({ length: count }, () => vi.fn())
  return {
    guard,
    terminate,
    owners,
    metrics,
    failures,
    admit: (index = 0) =>
      guard.admit(`lease-${index}`, index + 1, failures[index], (index + 1) * 100),
    ownersChanged: (next: PluginViewerProcessOwner[]) => {
      owners = next
    },
    sample: () => {
      at += PLUGIN_VIEWER_RESOURCE_SAMPLE_MS
      vi.advanceTimersByTime(PLUGIN_VIEWER_RESOURCE_SAMPLE_MS)
    },
    resume: () => {
      at += 60_000
      vi.advanceTimersByTime(PLUGIN_VIEWER_RESOURCE_SAMPLE_MS)
    }
  }
}

describe('viewer aggregate process resource guard', () => {
  it('withdraws authority before terminating only the verified child PID', () => {
    const f = fixture()
    expect(f.admit()).toBe(true)
    f.terminate.mockImplementation(() => expect(f.guard.isCurrent('lease-0')).toBe(false))
    expect(f.guard.terminateChildren('lease-0')).toBe(true)
    expect(f.terminate).toHaveBeenCalledExactlyOnceWith(101)
    expect(f.guard.terminateChildren('lease-0')).toBe(false)
  })
  it.each(['shared', 'replacement', 'unknown-peer', 'missing-metric'] as const)(
    'does not terminate a child when %s invalidates recovery ownership',
    (change) => {
      const f = fixture(2)
      expect(f.admit()).toBe(true)
      if (change === 'shared') {
        f.owners[1].frames[1].pid = 101
      }
      if (change === 'replacement') {
        f.metrics[1].creationTime++
      }
      if (change === 'unknown-peer') {
        f.owners[1].valid = false
      }
      if (change === 'missing-metric') {
        f.metrics.splice(1, 1)
      }
      expect(f.guard.terminateChildren('lease-0')).toBe(false)
      expect(f.terminate).not.toHaveBeenCalled()
      expect(f.guard.isCurrent('lease-0')).toBe(false)
    }
  )
  it('rejects duplicate ownership and cannot resurrect after disposal', () => {
    const f = fixture()
    expect(f.admit()).toBe(true)
    const duplicate = vi.fn()
    expect(f.guard.admit('another-lease', 1, duplicate, 100)).toBe(false)
    expect(duplicate).toHaveBeenCalledExactlyOnceWith('limit_exceeded')
    expect(f.guard.isCurrent('lease-0')).toBe(true)
    f.guard.dispose()
    expect(f.admit()).toBe(false)
    expect(f.failures[0]).toHaveBeenCalledExactlyOnceWith('unavailable')
  })
  it('preserves a pinned healthy viewer during a peer teardown while withholding new admission and crash authority', () => {
    const f = fixture(2)
    expect(f.admit()).toBe(true)
    f.owners[1].valid = false
    expect(f.admit(1)).toBe(false)
    expect(f.guard.isCurrent('lease-0')).toBe(true)
    expect(f.guard.isCurrent('lease-0', true)).toBe(false)
    f.sample()
    expect(f.failures[0]).not.toHaveBeenCalled()
    f.owners[1].frames[0].pid = f.owners[0].frames[0].pid
    f.sample()
    expect(f.failures[0]).toHaveBeenCalledExactlyOnceWith('unauthorized')
  })
  it('does not debit unrelated application or browser processes', () => {
    const f = fixture(2)
    f.metrics[2].residentBytes = 10_000 * mib
    f.metrics[2].type = 'Browser'
    f.metrics[3].cpuSeconds = 10_000
    expect(f.admit()).toBe(true)
    f.sample()
    expect(f.failures[0]).not.toHaveBeenCalled()
  })
  it('fails closed if individually finite counters overflow when combined', () => {
    const f = fixture()
    f.metrics[0].cpuSeconds = Number.MAX_VALUE
    f.metrics[1].cpuSeconds = Number.MAX_VALUE
    expect(f.admit()).toBe(false)
    expect(f.failures[0]).toHaveBeenCalledExactlyOnceWith('unavailable')
  })
  it('includes the opaque child renderer and stops sampling after last release', () => {
    const f = fixture()
    expect(f.admit()).toBe(true)
    expect(f.guard.isCurrent('lease-0')).toBe(true)
    f.metrics[1].residentBytes = 650 * mib
    f.sample()
    expect(f.failures[0]).toHaveBeenCalledExactlyOnceWith('limit_exceeded')
    expect(f.guard.isCurrent('lease-0')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('counts a process once when multiple owned frames share it', () => {
    const f = fixture()
    f.owners[0].frames[1].pid = f.owners[0].frames[0].pid
    f.metrics[0].residentBytes = 600 * mib
    expect(f.admit()).toBe(true)
    f.sample()
    expect(f.failures[0]).not.toHaveBeenCalled()
    f.guard.release('lease-0')
    f.guard.release('lease-0')
  })
  it('rejects a shared child process before admission and never counts host/browser resources', () => {
    const f = fixture(2)
    f.owners[1].frames[1].pid = f.owners[0].frames[1].pid
    expect(f.admit()).toBe(false)
    expect(f.failures[0]).toHaveBeenCalledExactlyOnceWith('unauthorized')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('withdraws a shared process after admission without invoking a peer termination operation', () => {
    const f = fixture(2)
    expect(f.admit()).toBe(true)
    expect(f.admit(1)).toBe(true)
    f.owners[1].frames[1].pid = f.owners[0].frames[1].pid
    expect(f.guard.isCurrent('lease-0')).toBe(false)
    f.sample()
    expect(f.failures[0]).toHaveBeenCalledExactlyOnceWith('unauthorized')
    expect(f.failures[1]).toHaveBeenCalledExactlyOnceWith('unauthorized')
  })
  it('fences Chromium process replacement even when the OS PID is reused', () => {
    const f = fixture()
    expect(f.admit()).toBe(true)
    f.owners[0].frames[1].processId++
    expect(f.guard.isCurrent('lease-0')).toBe(false)
    f.sample()
    expect(f.failures[0]).toHaveBeenCalledExactlyOnceWith('unauthorized')
  })
  it('checks process creation identity before accepting sampled metrics', () => {
    const f = fixture()
    expect(f.admit()).toBe(true)
    f.metrics[1].creationTime++
    f.sample()
    expect(f.failures[0]).toHaveBeenCalledExactlyOnceWith('unavailable')
  })
  it.each(['missing', 'cpu', 'memory', 'type'] as const)(
    'fails closed on unavailable %s metrics',
    (kind) => {
      const f = fixture()
      if (kind === 'missing') {
        f.metrics.splice(1, 1)
      }
      if (kind === 'cpu') {
        f.metrics[1].cpuSeconds = undefined
      }
      if (kind === 'memory') {
        f.metrics[1].residentBytes = Number.NaN
      }
      if (kind === 'type') {
        f.metrics[1].type = 'Browser'
      }
      expect(f.admit()).toBe(false)
      expect(f.failures[0]).toHaveBeenCalledExactlyOnceWith('unavailable')
    }
  )
  it('rejects unknown live peer ownership, invalid frame PIDs and changed frame topology', () => {
    const f = fixture(2)
    f.owners[1].valid = false
    expect(f.admit()).toBe(false)
    f.owners[1].valid = true
    f.owners[0].frames[1].pid = 0
    expect(f.admit()).toBe(false)
    f.owners[0].frames[1].pid = 101
    expect(f.admit()).toBe(true)
    f.ownersChanged(f.owners.slice(1))
    expect(f.guard.isCurrent('lease-0')).toBe(false)
  })
  it('enforces the aggregate memory budget, keeping older equal-size viewers', () => {
    const f = fixture(7)
    for (let index = 0; index < 6; index++) {
      expect(f.admit(index)).toBe(true)
    }
    expect(f.admit(6)).toBe(false)
    expect(f.failures[6]).toHaveBeenCalledExactlyOnceWith('limit_exceeded')
    expect(f.failures.slice(0, 6).every((fail) => fail.mock.calls.length === 0)).toBe(true)
  })
  it('retires only the largest offender when aggregate CPU exceeds its window budget', () => {
    const f = fixture(3)
    for (let index = 0; index < 3; index++) {
      expect(f.admit(index)).toBe(true)
    }
    f.metrics[1].cpuSeconds = 11
    f.metrics[3].cpuSeconds = 11
    f.metrics[5].cpuSeconds = 12
    f.sample()
    expect(f.failures[2]).toHaveBeenCalledExactlyOnceWith('limit_exceeded')
    expect(f.failures[0]).not.toHaveBeenCalled()
    expect(f.failures[1]).not.toHaveBeenCalled()
  })
  it('counts CPU across both renderers independently of app metric percentage resets', () => {
    const f = fixture()
    f.metrics[0].cpuSeconds = 200
    f.metrics[1].cpuSeconds = 300
    expect(f.admit()).toBe(true)
    f.metrics[0].cpuSeconds = 206
    f.metrics[1].cpuSeconds = 307
    f.sample()
    expect(f.failures[0]).toHaveBeenCalledExactlyOnceWith('limit_exceeded')
  })
  it('ages CPU samples out of the rolling window and resets after a long observation gap', () => {
    const f = fixture()
    expect(f.admit()).toBe(true)
    f.metrics[1].cpuSeconds = 10
    f.sample()
    for (let index = 0; index < 41; index++) {
      f.sample()
    }
    f.metrics[1].cpuSeconds = 20
    f.sample()
    expect(f.failures[0]).not.toHaveBeenCalled()
    f.metrics[1].cpuSeconds = 200
    f.resume()
    expect(f.failures[0]).not.toHaveBeenCalled()
    f.metrics[1].cpuSeconds = 199
    f.sample()
    expect(f.failures[0]).toHaveBeenCalledExactlyOnceWith('unavailable')
  })
})
