import { createRef } from 'react'
import { Animated, Modal, ScrollView, Text, View } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MobileSessionTitleBlock } from './MobileSessionTitleBlock'

const overlay = vi.hoisted((): {
  width: number
  height: number
  back: (() => boolean) | null
  finish: (() => void) | null
} => ({ width: 667, height: 375, back: null, finish: null }))
vi.mock('../layout/side-safe-area', () => ({
  useWindowSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('../navigation/use-back-claim', async () => {
  const { useEffect } = await import('react')
  return {
    useBackClaim: (claim: () => boolean) =>
      useEffect(() => {
        overlay.back = claim
        return () => { overlay.back = null }
      }, [claim])
  }
})

vi.mock('react-native', () => {
  class Value {
    constructor(public value: number) {}
    interpolate() {
      return this
    }
  }
  return {
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Modal: 'Modal',
    Platform: { OS: 'ios', select: (choices: { ios?: string }) => choices.ios },
    StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
    useWindowDimensions: () => ({ width: overlay.width, height: overlay.height }),
    Easing: { out: () => () => 0, cubic: () => 0 },
    Animated: {
      View: 'AnimatedView',
      Value,
      timing: (_value: unknown, config: { toValue: number }) => ({
        start: (done: (result: { finished: boolean }) => void) => {
          if (config.toValue === 0) overlay.finish = () => done({ finished: true })
          else done({ finished: true })
        },
        stop: () => {}
      })
    }
  }
})
vi.mock('../platform/use-reduced-motion', () => ({ useReducedMotionEnabled: () => false }))

const TITLE = 'brennanb2025/mobile-landscape-session-tabs'
const PATH = '/Users/me/orca/worktrees/mobile-landscape-session-tabs'

describe('session title card', () => {
  it('opens under the top bar with the full name, path and host, and closes on an outside tap', () => {
    const barRef = createRef<View>()
    const mounted: { renderer?: ReactTestRenderer } = {}
    const element = () => (
      <View ref={barRef}>
        <MobileSessionTitleBlock
          title={TITLE}
          path={PATH}
          hostName="openclaw"
          connState="connected"
          besideTabs
          barRef={barRef}
          meta="3 tabs"
          showConnectionRetry={false}
          onRetry={() => {}}
        />
      </View>
    )
    act(() => {
      mounted.renderer = create(
        element(),
        // The block reports x 80; the bar reports y 20 and height 45.
        {
          createNodeMock: () => ({
            measureInWindow: (done: (x: number, y: number, w: number, h: number) => void) =>
              done(80, 20, 160, 45)
          })
        }
      )
    })
    const root = mounted.renderer?.root
    if (!root) {
      throw new Error('not mounted')
    }
    const texts = () => root.findAllByType(Text).map((node) => node.props.children)
    const titleBlock = root.findAllByProps({ accessibilityRole: 'button' })[0]

    act(() => titleBlock?.props.onPress())

    const card = () => root.findByType(Animated.View)
    expect(card().props.style[1]).toMatchObject({ left: 80, top: 65, width: 256, maxHeight: 302 })
    expect(root.findByType(ScrollView).findAllByType(Text)).toHaveLength(3)
    expect(texts()).toEqual(expect.arrayContaining([PATH, 'openclaw']))
    expect(texts().filter((text) => text === TITLE)).toHaveLength(2)

    act(() => root.findByProps({ accessibilityLabel: 'Close details' }).props.onPress())
    expect(overlay.back).not.toBeNull()
    act(() => overlay.finish?.())
    expect(root.findAllByType(Modal)).toHaveLength(0)
    act(() => titleBlock?.props.onPress())
    overlay.height = 300
    act(() => mounted.renderer?.update(element()))
    expect(card().props.style[1].maxHeight).toBe(227)
    overlay.width = 375
    act(() => mounted.renderer?.update(element()))
    expect(overlay.back).not.toBeNull()
    act(() => overlay.finish?.())
    expect(root.findAllByType(Modal)).toHaveLength(0)
    act(() => titleBlock?.props.onPress())
    act(() => expect(overlay.back?.()).toBe(true))
    act(() => overlay.finish?.())
    expect(root.findAllByType(Modal)).toHaveLength(0)
    expect(overlay.back).toBeNull()
    act(() => mounted.renderer?.unmount())
  })
})
