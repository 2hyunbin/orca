import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { useAnimatedRef, useSharedValue } from 'react-native-reanimated'
import { DragReorderList } from './DragReorderList'

type Point = { absoluteY: number; translationY: number }
type Pan = {
  start?: (event: Point) => void
  update?: (event: Point) => void
  finish?: (event: Point, success: boolean) => void
}
const pans = vi.hoisted((): Pan[] => [])
vi.mock('../platform/haptics', () => ({
  triggerSelection: () => {},
  triggerMediumImpact: () => {}
}))
vi.mock('lucide-react-native', () => ({ GripVertical: 'GripVertical' }))
vi.mock('react-native', () => ({
  View: 'View',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 }
}))
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react')
  return {
    default: { View: 'AnimatedView' },
    useSharedValue: (value: unknown) => useRef({ value }).current,
    useAnimatedRef: () => useRef(null),
    useAnimatedStyle: (style: () => unknown) => style(),
    useFrameCallback: () => ({ setActive: () => {} }),
    measure: () => null,
    scrollTo: () => {},
    withSpring: (value: number) => value,
    runOnJS: (fn: unknown) => fn
  }
})
vi.mock('react-native-gesture-handler', () => ({
  GestureDetector: 'GestureDetector',
  Gesture: {
    Pan: () => {
      const callbacks: Pan = {}
      pans.push(callbacks)
      const chain = {
        enabled: () => chain,
        activateAfterLongPress: () => chain,
        shouldCancelWhenOutside: () => chain,
        onStart: (callback: Pan['start']) => {
          callbacks.start = callback
          return chain
        },
        onUpdate: (callback: Pan['update']) => {
          callbacks.update = callback
          return chain
        },
        onFinalize: (callback: Pan['finish']) => {
          callbacks.finish = callback
          return chain
        }
      }
      return chain
    }
  }
}))

it('keeps measured rows still on hold, restores cancellation, and drops by moved ID plus neighbor', async () => {
  const move = vi.fn()
  function Harness() {
    return (
      <DragReorderList
        items={['a', 'b', 'c']}
        itemKey={(item) => item}
        rowPresentation="plain"
        renderRow={(item, handle) => (
          <>
            {item}
            {handle}
          </>
        )}
        onMove={move}
        scrollRef={useAnimatedRef()}
        scrollOffsetY={useSharedValue(0)}
        scrollContentHeight={useSharedValue(140)}
      />
    )
  }
  let mounted!: ReactTestRenderer
  await act(async () => {
    mounted = create(createElement(Harness))
  })
  const rows = mounted.root.findAll((node) => typeof node.props.onLayout === 'function')
  await act(async () =>
    rows.forEach((row, index) =>
      row.props.onLayout({ nativeEvent: { layout: { height: index === 0 ? 100 : 20 } } })
    )
  )
  const first = pans.at(-3)!
  const at = (translationY: number) => ({ absoluteY: 100 + translationY, translationY })
  act(() => {
    first.start?.(at(0))
    first.update?.(at(0))
    first.finish?.(at(0), true)
  })
  expect(move).not.toHaveBeenCalled()
  act(() => {
    first.start?.(at(0))
    first.update?.(at(35))
    first.finish?.(at(35), false)
  })
  expect(move).not.toHaveBeenCalled()
  act(() => {
    first.start?.(at(0))
    first.update?.(at(0))
    first.finish?.(at(0), true)
  })
  expect(move).not.toHaveBeenCalled()
  act(() => {
    first.start?.(at(0))
    first.update?.(at(35))
    first.finish?.(at(35), true)
  })
  expect(move).toHaveBeenCalledExactlyOnceWith({ movedId: 'a', afterId: 'c' })
  act(() => mounted.unmount())
})
