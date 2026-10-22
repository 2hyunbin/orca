import { createElement, type ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import Animated, { useAnimatedRef, useSharedValue } from 'react-native-reanimated'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type DragEvent = { absoluteY: number; translationY: number }
type GestureCallbacks = Record<string, (event: DragEvent, success: boolean) => void>
const probe = vi.hoisted(
  (): {
    layouts: { value: unknown; inputs: unknown[] }[]
    styleInputs: unknown[][]
    gestures: GestureCallbacks[]
    shared: { value: unknown }[]
    frameActive: ReturnType<typeof vi.fn>
    deferJS: boolean
    jsQueue: (() => void)[]
    frame: ((frame: { timeSincePreviousFrame: number }) => void) | null
    scroll: ReturnType<typeof vi.fn>
    viewport: { pageY: number; height: number } | null
  } => ({
    layouts: [],
    styleInputs: [],
    gestures: [],
    shared: [],
    frameActive: vi.fn(),
    deferJS: false,
    jsQueue: [],
    frame: null,
    scroll: vi.fn(),
    viewport: null
  })
)

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('react-native-gesture-handler', async () => {
  const React = await import('react')
  return {
    GestureDetector: ({ children }: { children: ReactNode }) =>
      React.createElement('GestureDetector', null, children),
    Gesture: {
      Pan: () => {
        const callbacks: GestureCallbacks = {}
        probe.gestures.push(callbacks)
        const gesture = {
          enabled: () => gesture,
          activateAfterLongPress: () => gesture,
          shouldCancelWhenOutside: () => gesture,
          onStart: (fn: GestureCallbacks[string]) => {
            callbacks.start = fn
            return gesture
          },
          onUpdate: (fn: GestureCallbacks[string]) => {
            callbacks.update = fn
            return gesture
          },
          onFinalize: (fn: GestureCallbacks[string]) => {
            callbacks.finalize = fn
            return gesture
          }
        }
        return gesture
      }
    }
  }
})
vi.mock('react-native-reanimated', async () => {
  const React = await import('react')
  return {
    default: {
      View: ({ children, ...props }: { children?: ReactNode }) =>
        React.createElement('AnimatedView', props, children)
    },
    useSharedValue: (value: unknown) => {
      const held = React.useRef({ value })
      if (!probe.shared.includes(held.current)) {
        probe.shared.push(held.current)
      }
      return held.current
    },
    useAnimatedRef: () => React.useRef(Object.assign(() => null, { current: null })).current,
    useDerivedValue: (fn: () => unknown, inputs: unknown[]) => {
      const layout = React.useMemo(
        () => ({
          get value() {
            return fn()
          },
          inputs
        }),
        inputs
      )
      probe.layouts.push(layout)
      return layout
    },
    useAnimatedStyle: (fn: () => unknown, inputs: unknown[]) => {
      probe.styleInputs.push(inputs)
      return fn()
    },
    useFrameCallback: (fn: (frame: { timeSincePreviousFrame: number }) => void) => {
      probe.frame = fn
      return { setActive: probe.frameActive }
    },
    withSpring: (value: number) => value,
    runOnJS:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) => {
        if (probe.deferJS) {
          probe.jsQueue.push(() => fn(...args))
        } else {
          fn(...args)
        }
      },
    runOnUI: (fn: unknown) => fn,
    measure: () => probe.viewport,
    scrollTo: probe.scroll
  }
})
vi.mock('lucide-react-native', () => ({ GripVertical: () => null }))
vi.mock('../platform/haptics', () => ({ triggerMediumImpact: vi.fn(), triggerSelection: vi.fn() }))

import { DragReorderList } from './DragReorderList'

beforeEach(() => {
  probe.layouts.length = 0
  probe.styleInputs.length = 0
  probe.gestures.length = 0
  probe.shared.length = 0
  probe.frameActive.mockClear()
  probe.deferJS = false
  probe.jsQueue.length = 0
  probe.frame = null
  probe.scroll.mockClear()
  probe.viewport = null
})

async function mounted({
  initialIds = ['a', 'b'],
  canMove,
  onMove
}: {
  initialIds?: string[]
  canMove?: (item: { id: string }) => boolean
  onMove?: (move: { movedId: string } & ({ beforeId: string } | { afterId: string })) => void
} = {}) {
  const onReorder = vi.fn()
  const onActive = vi.fn()
  let root: ReturnType<typeof create>
  function Harness({ ids = initialIds }: { ids?: string[] }) {
    const scrollRef = useAnimatedRef<Animated.ScrollView>()
    const scrollOffsetY = useSharedValue(0)
    const scrollContentHeight = useSharedValue(144)
    return createElement(DragReorderList<{ id: string }>, {
      items: ids.map((id) => ({ id })),
      itemKey: (item) => item.id,
      canMove,
      rowHeight: 72,
      renderRow: (item) => createElement('Text', null, item.id),
      onReorder,
      onMove,
      onDragActiveChange: (active: boolean) => onActive(active),
      scrollRef,
      scrollOffsetY,
      scrollContentHeight
    })
  }
  await act(async () => {
    root = create(createElement(Harness))
  })
  return {
    root: root!,
    onReorder,
    onActive,
    gesture: probe.gestures[0]!,
    updateItems: async (ids: string[]) => {
      await act(async () => root!.update(createElement(Harness, { ids })))
    }
  }
}

function positions() {
  return probe.shared.findLast(
    (held) =>
      held.value &&
      typeof held.value === 'object' &&
      'a' in held.value &&
      typeof held.value.a === 'number' &&
      held.value.a >= 0 &&
      held.value.a < 3
  )!.value
}

describe('drag completion and cancellation', () => {
  it('restores original positions and writes nothing when an active drag is cancelled', async () => {
    const fixture = await mounted()
    await act(async () => {
      fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true)
      fixture.gesture.update!({ absoluteY: 180, translationY: 80 }, true)
    })
    expect(positions()).toEqual({ a: 1, b: 0 })
    await act(async () => fixture.gesture.finalize!({ absoluteY: 180, translationY: 80 }, false))
    expect(positions()).toEqual({ a: 0, b: 1 })
    expect(fixture.onReorder).not.toHaveBeenCalled()
    expect(fixture.onActive.mock.calls).toEqual([[true], [false]])
    expect(probe.frameActive).toHaveBeenLastCalledWith(false)
    await act(async () => fixture.root.unmount())
  })

  it('commits the moved order once on a successful drop', async () => {
    const fixture = await mounted()
    await act(async () => {
      fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true)
      fixture.gesture.update!({ absoluteY: 180, translationY: 80 }, true)
      fixture.gesture.finalize!({ absoluteY: 180, translationY: 80 }, true)
    })
    expect(fixture.onReorder.mock.calls).toEqual([[['b', 'a']]])
    await act(async () => fixture.root.unmount())
  })

  it('does not write after a failed activation or an unchanged drop', async () => {
    const fixture = await mounted()
    await act(async () => {
      fixture.gesture.finalize!({ absoluteY: 100, translationY: 0 }, false)
      fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true)
      fixture.gesture.finalize!({ absoluteY: 100, translationY: 0 }, true)
    })
    expect(fixture.onReorder).not.toHaveBeenCalled()
    await act(async () => fixture.root.unmount())
  })

  it.each([
    { ids: ['a', 'mail'], distance: 80, expected: { a: 0, mail: 1 }, changed: false },
    { ids: ['a', 'mail', 'b'], distance: 80, expected: { a: 0, mail: 1, b: 2 }, changed: false },
    { ids: ['a', 'mail', 'b'], distance: 160, expected: { b: 0, mail: 1, a: 2 }, changed: true }
  ])('settles a drag across protected mail at $distance with $ids', async (test) => {
    const onMove = vi.fn()
    const fixture = await mounted({
      initialIds: test.ids,
      canMove: (item) => item.id !== 'mail',
      onMove
    })
    await act(async () => {
      fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true)
      fixture.gesture.update!({ absoluteY: 100 + test.distance, translationY: test.distance }, true)
    })
    expect(positions()).not.toEqual(test.expected)
    await act(async () =>
      fixture.gesture.finalize!(
        { absoluteY: 100 + test.distance, translationY: test.distance },
        true
      )
    )
    expect(positions()).toEqual(test.expected)
    if (test.changed) {
      expect(onMove).toHaveBeenCalledExactlyOnceWith({ movedId: 'a', afterId: 'b' })
      await fixture.updateItems(['b', 'mail', 'a'])
      await fixture.updateItems(test.ids)
      expect(positions()).toEqual({ a: 0, mail: 1, b: 2 })
    } else {
      expect(onMove).not.toHaveBeenCalled()
      expect(fixture.onReorder).not.toHaveBeenCalled()
    }
    await act(async () => fixture.root.unmount())
  })
})

describe('catalog changes during a drag', () => {
  it('releases the scroll lock when the held row disappears and ignores its late cancellation', async () => {
    const fixture = await mounted()
    await act(async () => {
      fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true)
      fixture.gesture.update!({ absoluteY: 180, translationY: 80 }, true)
    })
    await fixture.updateItems(['b', 'c'])
    expect(fixture.onActive.mock.calls).toEqual([[true], [false]])
    expect(probe.frameActive).toHaveBeenLastCalledWith(false)
    await act(async () => fixture.gesture.finalize!({ absoluteY: 180, translationY: 80 }, false))
    expect(
      probe.shared.some(
        (held) =>
          held.value &&
          typeof held.value === 'object' &&
          'b' in held.value &&
          'c' in held.value &&
          !('a' in held.value)
      )
    ).toBe(true)
    expect(fixture.onReorder).not.toHaveBeenCalled()
    await act(async () => fixture.root.unmount())
  })

  it.each([{ ids: ['a', 'b', 'c'] }, { ids: ['b', 'a'] }])(
    'does not commit a stale drag after the catalog becomes $ids',
    async ({ ids }) => {
      const fixture = await mounted()
      await act(async () => {
        fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true)
        fixture.gesture.update!({ absoluteY: 180, translationY: 80 }, true)
      })
      await fixture.updateItems(ids)
      await act(async () => fixture.gesture.finalize!({ absoluteY: 180, translationY: 80 }, true))
      expect(fixture.onReorder).not.toHaveBeenCalled()
      expect(fixture.onActive.mock.calls).toEqual([[true], [false]])
      await act(async () => fixture.root.unmount())
    }
  )

  it('releases its owner when unmounted while a row is held', async () => {
    const fixture = await mounted()
    await act(async () => fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true))
    await act(async () => fixture.root.unmount())
    expect(fixture.onActive.mock.calls).toEqual([[true], [false]])
    expect(probe.frameActive).toHaveBeenLastCalledWith(false)
    expect(fixture.onReorder).not.toHaveBeenCalled()
  })

  it('keeps a drag when only row metadata refreshes', async () => {
    const fixture = await mounted()
    await act(async () => {
      fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true)
      fixture.gesture.update!({ absoluteY: 180, translationY: 80 }, true)
    })
    await fixture.updateItems(['a', 'b'])
    expect(fixture.onActive.mock.calls).toEqual([[true]])
    probe.deferJS = true
    await act(async () => fixture.gesture.finalize!({ absoluteY: 180, translationY: 80 }, true))
    await fixture.updateItems(['a', 'b'])
    await act(async () => {
      probe.jsQueue.splice(0).forEach((fn) => fn())
    })
    expect(fixture.onReorder.mock.calls).toEqual([[['b', 'a']]])
    await act(async () => fixture.root.unmount())
  })
})

describe('late gesture callbacks', () => {
  it('ignores movement delivered after the row catalog changes', async () => {
    const fixture = await mounted()
    await act(async () => fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true))
    await fixture.updateItems(['a', 'b', 'c'])
    await act(async () => fixture.gesture.update!({ absoluteY: 180, translationY: 80 }, true))
    expect(positions()).toEqual({ a: 0, b: 1, c: 2 })
    expect(fixture.onReorder).not.toHaveBeenCalled()
    await act(async () => fixture.root.unmount())
  })

  it.each([
    ['a', 'b', 'c'],
    ['b', 'a']
  ])('does not save a completed drop queued before catalog %j replaces it', async (...ids) => {
    const fixture = await mounted()
    await act(async () => {
      fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true)
      fixture.gesture.update!({ absoluteY: 180, translationY: 80 }, true)
      probe.deferJS = true
      fixture.gesture.finalize!({ absoluteY: 180, translationY: 80 }, true)
    })
    await fixture.updateItems(ids)
    await act(async () => {
      probe.jsQueue.splice(0).forEach((fn) => fn())
    })
    expect(fixture.onReorder).not.toHaveBeenCalled()
    await act(async () => fixture.root.unmount())
  })

  it('does not revive a queued drop when the original row order returns', async () => {
    const fixture = await mounted()
    await act(async () => {
      fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true)
      fixture.gesture.update!({ absoluteY: 180, translationY: 80 }, true)
      probe.deferJS = true
      fixture.gesture.finalize!({ absoluteY: 180, translationY: 80 }, true)
    })
    await fixture.updateItems(['b', 'a'])
    await fixture.updateItems(['a', 'b'])
    await act(async () => {
      probe.jsQueue.splice(0).forEach((fn) => fn())
    })
    expect(fixture.onReorder).not.toHaveBeenCalled()
    expect(positions()).toEqual({ a: 0, b: 1 })
    await act(async () => fixture.root.unmount())
  })

  it('does not save a completed drop after unmount', async () => {
    const fixture = await mounted()
    await act(async () => {
      fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true)
      fixture.gesture.update!({ absoluteY: 180, translationY: 80 }, true)
      probe.deferJS = true
      fixture.gesture.finalize!({ absoluteY: 180, translationY: 80 }, true)
    })
    await act(async () => fixture.root.unmount())
    await act(async () => {
      probe.jsQueue.splice(0).forEach((fn) => fn())
    })
    expect(fixture.onReorder).not.toHaveBeenCalled()
  })
})

it('stops scrolling at the viewport edge when rows are replaced', async () => {
  const fixture = await mounted()
  probe.viewport = { pageY: 0, height: 100 }
  await act(async () => {
    fixture.gesture.start!({ absoluteY: 90, translationY: 0 }, true)
    probe.frame!({ timeSincePreviousFrame: 16 })
  })
  expect(probe.scroll).toHaveBeenCalledTimes(1)
  await fixture.updateItems(['b', 'c'])
  await act(async () => probe.frame!({ timeSincePreviousFrame: 16 }))
  expect(probe.scroll).toHaveBeenCalledTimes(1)
  expect(probe.frameActive).toHaveBeenLastCalledWith(false)
  await act(async () => fixture.root.unmount())
})

it('keeps measured rows still on hold, restores cancellation, and drops by moved ID plus neighbor', async () => {
  const move = vi.fn()
  function Harness() {
    return createElement(DragReorderList<string>, {
      items: ['a', 'b', 'c'],
      itemKey: (item) => item,
      rowPresentation: 'plain',
      renderRow: (item, handle) => createElement('Text', null, item, handle),
      onMove: move,
      scrollRef: useAnimatedRef<Animated.ScrollView>(),
      scrollOffsetY: useSharedValue(0),
      scrollContentHeight: useSharedValue(140)
    })
  }
  let root: ReturnType<typeof create>
  await act(async () => {
    root = create(createElement(Harness))
  })
  const rows = root!.root.findAll(
    (node) => node.type === 'AnimatedView' && typeof node.props.onLayout === 'function'
  )
  await act(async () =>
    rows.forEach((row, index) =>
      row.props.onLayout({ nativeEvent: { layout: { height: index === 0 ? 100 : 20 } } })
    )
  )
  const gesture = probe.gestures.at(-3)!
  const at = (translationY: number) => ({ absoluteY: 100 + translationY, translationY })
  await act(async () => {
    gesture.start!(at(0), true)
    gesture.update!(at(0), true)
    gesture.finalize!(at(0), true)
    gesture.start!(at(0), true)
    gesture.update!(at(35), true)
    gesture.finalize!(at(35), false)
  })
  expect(move).not.toHaveBeenCalled()
  await act(async () => {
    gesture.start!(at(0), true)
    gesture.update!(at(35), true)
    gesture.finalize!(at(35), true)
  })
  expect(move).toHaveBeenCalledExactlyOnceWith({ movedId: 'a', afterId: 'c' })
  await act(async () => root!.unmount())
})

it('supplies geometry inputs to both Web mappers and recalculates layout after a slot change', async () => {
  const fixture = await mounted()
  const layout = probe.layouts.at(-1)!
  expect(layout.inputs).toHaveLength(2)
  expect(layout.inputs.every((input) => probe.shared.some((shared) => shared === input))).toBe(true)
  expect(probe.styleInputs.every((inputs) => inputs.includes(layout))).toBe(true)
  expect(layout.value).toEqual({ keys: ['a', 'b'], tops: { a: 0, b: 72 } })
  await act(async () => {
    fixture.gesture.start!({ absoluteY: 80, translationY: 0 }, true)
    fixture.gesture.update!({ absoluteY: 160, translationY: 80 }, true)
  })
  expect(layout.value).toEqual({ keys: ['b', 'a'], tops: { b: 0, a: 72 } })
  await act(async () => fixture.gesture.finalize!({ absoluteY: 160, translationY: 80 }, false))
  expect(layout.value).toEqual({ keys: ['a', 'b'], tops: { a: 0, b: 72 } })
  await act(async () => fixture.root.unmount())
})
