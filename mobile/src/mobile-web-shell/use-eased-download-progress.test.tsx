import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type TimingConfig = { toValue: number; duration: number; easing: unknown; useNativeDriver: boolean }

const motion: { reduced: boolean; set: number[]; timings: TimingConfig[] } = vi.hoisted(() => ({
  reduced: false,
  set: [],
  timings: []
}))

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => Promise.resolve(motion.reduced),
    addEventListener: () => ({ remove: () => {} })
  },
  Easing: { linear: 'linear' },
  Animated: {
    Value: class {
      setValue(value: number): void {
        motion.set.push(value)
      }
      stopAnimation(): void {}
    },
    timing: (_value: unknown, config: TimingConfig) => ({
      start: () => {
        motion.timings.push(config)
      }
    })
  }
}))

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { useEasedDownloadProgress } from './use-eased-download-progress'

function Probe({ fraction }: { fraction: number }) {
  useEasedDownloadProgress(fraction)
  return null
}

let tree: ReactTestRenderer | null = null

async function render(fraction: number): Promise<void> {
  await act(async () => {
    if (tree === null) {
      tree = create(createElement(Probe, { fraction }))
    } else {
      tree.update(createElement(Probe, { fraction }))
    }
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(0)
  motion.reduced = false
  motion.set = []
  motion.timings = []
})

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  vi.useRealTimers()
})

describe('useEasedDownloadProgress', () => {
  it('glides to each update over the averaged gap, starting from the mount', async () => {
    await render(0)
    vi.setSystemTime(800)
    await render(0.25)
    vi.setSystemTime(1200)
    await render(0.5)
    expect(motion.timings).toEqual([
      { toValue: 0.25, duration: 800, easing: 'linear', useNativeDriver: true },
      { toValue: 0.5, duration: 600, easing: 'linear', useNativeDriver: true }
    ])
    expect(motion.set).toEqual([])
  })

  it('keeps the glide for a burst of replies instead of letting their tiny gaps shorten it', async () => {
    const burst = async (startMs: number, fractions: number[]): Promise<void> => {
      for (const [index, fraction] of fractions.entries()) {
        vi.setSystemTime(startMs + index * 5)
        await render(fraction)
      }
    }
    await render(0)
    await burst(1600, [0.1, 0.15, 0.2, 0.25])
    await burst(3200, [0.35, 0.4, 0.45, 0.5])
    expect(motion.timings.map((timing) => timing.duration)).toEqual(Array(8).fill(1600))
    expect(motion.timings.map((timing) => timing.toValue)).toEqual([
      0.1, 0.15, 0.2, 0.25, 0.35, 0.4, 0.45, 0.5
    ])
  })

  it('does not count a re-render with the same fraction as an update', async () => {
    await render(0.1)
    vi.setSystemTime(300)
    await render(0.1)
    vi.setSystemTime(1000)
    await render(0.2)
    expect(motion.timings.map((timing) => timing.duration)).toEqual([1000])
  })

  it('snaps when reduce motion is on', async () => {
    motion.reduced = true
    await render(0)
    vi.setSystemTime(500)
    await render(0.4)
    expect(motion.timings).toEqual([])
    expect(motion.set).toEqual([0.4])
  })

  it('snaps down rather than gliding through values above the received one', async () => {
    await render(0.6)
    vi.setSystemTime(500)
    await render(0.3)
    expect(motion.timings).toEqual([])
    expect(motion.set).toEqual([0.3])
  })
})
