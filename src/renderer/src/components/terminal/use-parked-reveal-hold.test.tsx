// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginParkedRevealPaint, onParkedRevealPaintSettled } from './parked-reveal-paint-signal'
import { PARKED_REVEAL_HOLD_MAX_MS, useParkedRevealHold } from './use-parked-reveal-hold'

type Props = {
  selectedWorktreeId: string | null
  parkedWorktreeIds: ReadonlySet<string>
  mountedWorktreeIds: ReadonlySet<string>
}

const MOUNTED = new Set(['wt-a', 'wt-b'])

function renderHold(initial: Partial<Props> = {}) {
  return renderHook((props: Props) => useParkedRevealHold(props), {
    initialProps: {
      selectedWorktreeId: 'wt-a',
      parkedWorktreeIds: new Set(['wt-b']),
      mountedWorktreeIds: MOUNTED,
      ...initial
    }
  })
}

const switchToB = { selectedWorktreeId: 'wt-b', parkedWorktreeIds: new Set(['wt-b']) }

describe('useParkedRevealHold', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('holds the outgoing workspace until the parked one has painted', () => {
    const hook = renderHold()
    let settle = (): void => {}
    hook.rerender({ ...switchToB, mountedWorktreeIds: MOUNTED })
    // Nothing was pending when effects ran, so a hold with no remount would release at once.
    expect(hook.result.current.hold).toBeNull()

    hook.rerender({
      selectedWorktreeId: 'wt-a',
      parkedWorktreeIds: new Set(['wt-b']),
      mountedWorktreeIds: MOUNTED
    })
    settle = beginParkedRevealPaint('wt-b')
    hook.rerender({ ...switchToB, mountedWorktreeIds: MOUNTED })
    expect(hook.result.current.hold).toEqual({ from: 'wt-a', to: 'wt-b' })

    act(() => settle())
    expect(hook.result.current.hold).toBeNull()
  })

  it('releases at the cap when the parked pane never paints', () => {
    const settle = beginParkedRevealPaint('wt-b')
    const hook = renderHold()
    hook.rerender({ ...switchToB, mountedWorktreeIds: MOUNTED })
    expect(hook.result.current.hold).not.toBeNull()

    act(() => vi.advanceTimersByTime(PARKED_REVEAL_HOLD_MAX_MS - 1))
    expect(hook.result.current.hold).not.toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(hook.result.current.hold).toBeNull()
    settle()
  })

  it('releases on input to the selected workspace', () => {
    const settle = beginParkedRevealPaint('wt-b')
    const hook = renderHold()
    hook.rerender({ ...switchToB, mountedWorktreeIds: MOUNTED })

    act(() => hook.result.current.releaseHold())

    expect(hook.result.current.hold).toBeNull()
    settle()
  })

  it('does not hold for a warm workspace, a first selection, or an unmounted outgoing one', () => {
    const settle = beginParkedRevealPaint('wt-b')
    const warm = renderHold({ parkedWorktreeIds: new Set() })
    warm.rerender({
      selectedWorktreeId: 'wt-b',
      parkedWorktreeIds: new Set(),
      mountedWorktreeIds: MOUNTED
    })
    expect(warm.result.current.hold).toBeNull()

    const first = renderHold({ selectedWorktreeId: null })
    first.rerender({ ...switchToB, mountedWorktreeIds: MOUNTED })
    expect(first.result.current.hold).toBeNull()

    const unmounted = renderHold({ mountedWorktreeIds: new Set(['wt-b']) })
    unmounted.rerender({ ...switchToB, mountedWorktreeIds: new Set(['wt-b']) })
    expect(unmounted.result.current.hold).toBeNull()
    settle()
  })

  it('keeps the painted outgoing workspace when the selection moves again mid-hold', () => {
    const settleB = beginParkedRevealPaint('wt-b')
    const settleC = beginParkedRevealPaint('wt-c')
    const hook = renderHold({ parkedWorktreeIds: new Set(['wt-b', 'wt-c']) })
    const mounted = new Set(['wt-a', 'wt-b', 'wt-c'])
    hook.rerender({
      selectedWorktreeId: 'wt-b',
      parkedWorktreeIds: new Set(['wt-b', 'wt-c']),
      mountedWorktreeIds: mounted
    })
    hook.rerender({
      selectedWorktreeId: 'wt-c',
      parkedWorktreeIds: new Set(['wt-c']),
      mountedWorktreeIds: mounted
    })

    expect(hook.result.current.hold).toEqual({ from: 'wt-a', to: 'wt-c' })
    act(() => settleB())
    expect(hook.result.current.hold).toEqual({ from: 'wt-a', to: 'wt-c' })
    act(() => settleC())
    expect(hook.result.current.hold).toBeNull()
  })
})

describe('parked reveal paint signal', () => {
  it('settles each mount once, including a teardown after paint', () => {
    const first = beginParkedRevealPaint('wt-x')
    const second = beginParkedRevealPaint('wt-x')
    first()
    first()
    second()
    const late = beginParkedRevealPaint('wt-x')
    late()
    late()
    const next = beginParkedRevealPaint('wt-x')
    let woke = 0
    const listener = (): void => {
      woke += 1
    }
    const unsubscribe = onParkedRevealPaintSettled('wt-x', listener)
    next()
    unsubscribe()
    expect(woke).toBe(1)
  })
})
