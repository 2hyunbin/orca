import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaMobileWebShellSparesModule } from '../../modules/orca-mobile-web-shell/src'
import { deriveHostCacheKey } from './host-cache-key'
import type { MobileWebShellRuntime } from './mobile-web-shell-runtime'

const appState = vi.hoisted(() => ({
  current: 'active',
  listeners: new Set<(state: string) => void>()
}))

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.current
    },
    addEventListener: (_: string, listener: (state: string) => void) => {
      appState.listeners.add(listener)
      return { remove: () => appState.listeners.delete(listener) }
    }
  }
}))
// Focused for as long as the screen is mounted, which is what a screen on top of the stack is.
vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => undefined | (() => void)) => useEffect(effect, [effect])
}))

import { SPARE_REFILL_DELAY_MS, useSparePageRefill } from './use-spare-page-refill'

type Props = { painted: boolean; ownsHostArea: boolean; runtime: MobileWebShellRuntime }

function Probe(props: Props) {
  useSparePageRefill({ hostId: 'host-1', generationDirectory: '/gen/b', ...props })
  return null
}

function runtimeWith(spares?: OrcaMobileWebShellSparesModule): {
  runtime: MobileWebShellRuntime
  prepared: string[][]
} {
  const prepared: string[][] = []
  let minted = 0
  return {
    prepared,
    runtime: {
      createStore: () => {
        throw new Error('no store in this test')
      },
      mintSessionId: () => `minted-${String((minted += 1))}`,
      ...(spares === undefined ? {} : { spares }),
      now: () => 0,
      setTimer: () => () => {}
    }
  }
}

function pool(prepared: string[][]): OrcaMobileWebShellSparesModule {
  return {
    prepareSpare: async (hostKey, directory, sessionId) => {
      prepared.push([hostKey, directory, sessionId])
    },
    takeSpare: async () => null,
    discardSpares: async () => undefined
  }
}

describe('the spare refill', () => {
  let tree: ReactTestRenderer | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    appState.current = 'active'
    appState.listeners.clear()
  })

  afterEach(() => {
    act(() => tree?.unmount())
    tree = null
    vi.useRealTimers()
  })

  function render(props: Props) {
    act(() => {
      if (tree === null) {
        tree = create(createElement(Probe, props))
      } else {
        tree.update(createElement(Probe, props))
      }
    })
  }

  it('boots one page for this host once the page on screen has painted and settled', () => {
    const prepared: string[][] = []
    const { runtime } = runtimeWith(pool(prepared))
    render({ painted: false, ownsHostArea: false, runtime })
    act(() => {
      vi.advanceTimersByTime(SPARE_REFILL_DELAY_MS * 5)
    })
    expect(prepared).toEqual([])
    render({ painted: true, ownsHostArea: false, runtime })
    act(() => {
      vi.advanceTimersByTime(SPARE_REFILL_DELAY_MS - 1)
    })
    expect(prepared).toEqual([])
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(prepared).toEqual([[deriveHostCacheKey('host-1'), '/gen/b', 'minted-1']])
  })

  it('boots none for a page that owns the host area, or on a binary without the pool', () => {
    const prepared: string[][] = []
    render({ painted: true, ownsHostArea: true, runtime: runtimeWith(pool(prepared)).runtime })
    act(() => tree?.unmount())
    tree = null
    render({ painted: true, ownsHostArea: false, runtime: runtimeWith().runtime })
    act(() => {
      vi.advanceTimersByTime(SPARE_REFILL_DELAY_MS * 5)
    })
    expect(prepared).toEqual([])
  })

  it('waits while the app is in the background, and boots again when it comes back', () => {
    const prepared: string[][] = []
    const { runtime } = runtimeWith(pool(prepared))
    render({ painted: true, ownsHostArea: false, runtime })
    act(() => {
      for (const listener of appState.listeners) {
        listener('background')
      }
    })
    act(() => {
      vi.advanceTimersByTime(SPARE_REFILL_DELAY_MS * 5)
    })
    expect(prepared).toEqual([])
    act(() => {
      for (const listener of appState.listeners) {
        listener('active')
      }
    })
    act(() => {
      vi.advanceTimersByTime(SPARE_REFILL_DELAY_MS)
    })
    expect(prepared).toHaveLength(1)
  })
})
