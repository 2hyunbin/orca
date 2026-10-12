import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Glide = { toValue: number; duration: number }

const motion: { reduced: boolean; glides: Glide[] } = vi.hoisted(() => ({
  reduced: false,
  glides: []
}))

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => Promise.resolve(motion.reduced),
    addEventListener: () => ({ remove: () => {} })
  },
  Easing: { linear: 'linear' },
  Animated: {
    Value: class {},
    timing: (_value: unknown, { toValue, duration }: Glide) => ({
      start: () => {
        motion.glides.push({ toValue, duration })
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

async function renderAt(ms: number, fraction: number): Promise<void> {
  vi.setSystemTime(ms)
  await render(fraction)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(0)
  motion.reduced = false
  motion.glides = []
})

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  vi.useRealTimers()
})

describe('useEasedDownloadProgress', () => {
  it('glides to each update over the averaged gap, the first measured from the mount', async () => {
    await render(0)
    await renderAt(800, 0.25)
    await renderAt(1200, 0.5)
    expect(motion.glides).toEqual([
      { toValue: 0.25, duration: 800 },
      { toValue: 0.5, duration: 600 }
    ])
  })

  it('keeps the glide for a burst of replies instead of letting their tiny gaps shorten it', async () => {
    const burst = async (startMs: number, fractions: number[]): Promise<void> => {
      for (const [index, fraction] of fractions.entries()) {
        await renderAt(startMs + index * 5, fraction)
      }
    }
    await render(0)
    await burst(1600, [0.1, 0.15, 0.2, 0.25])
    await burst(3200, [0.35, 0.4, 0.45, 0.5])
    expect(motion.glides).toEqual(
      [0.1, 0.15, 0.2, 0.25, 0.35, 0.4, 0.45, 0.5].map((toValue) => ({ toValue, duration: 1600 }))
    )
  })

  it('clamps the glide between 200 ms and 2 s', async () => {
    await render(0)
    await renderAt(50, 0.1)
    await renderAt(5050, 0.2)
    expect(motion.glides).toEqual([
      { toValue: 0.1, duration: 200 },
      { toValue: 0.2, duration: 2000 }
    ])
  })

  it('does not count the reduce-motion setting arriving after mount as an update', async () => {
    // The setting resolves inside this render's act, re-running the effect with the same fraction.
    await render(0.1)
    await renderAt(1000, 0.2)
    expect(motion.glides).toEqual([{ toValue: 0.2, duration: 1000 }])
  })

  it('jumps straight to each update when reduce motion is on', async () => {
    motion.reduced = true
    await render(0)
    await renderAt(500, 0.4)
    expect(motion.glides).toEqual([{ toValue: 0.4, duration: 0 }])
  })
})
