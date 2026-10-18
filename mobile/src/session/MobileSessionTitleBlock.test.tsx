import { createRef } from 'react'
import { View } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MobileSessionTitleBlock } from './MobileSessionTitleBlock'

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
    Modal: 'Modal',
    Platform: { OS: 'ios' },
    StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
    useWindowDimensions: () => ({ width: 667, height: 375 }),
    Easing: { out: () => () => 0, cubic: () => 0 },
    Animated: {
      View: 'AnimatedView',
      Value,
      timing: () => ({
        start: (done: (result: { finished: boolean }) => void) => done({ finished: true }),
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
    act(() => {
      mounted.renderer = create(
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
        </View>,
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
    const texts = () => root.findAllByType('Text').map((node) => node.props.children)
    const titleBlock = root.findAllByProps({ accessibilityRole: 'button' })[0]

    act(() => titleBlock?.props.onPress())

    const card = root.findByType('AnimatedView')
    expect(card.props.style[1]).toMatchObject({ left: 80, top: 65, width: 256 })
    expect(texts()).toEqual(expect.arrayContaining([PATH, 'openclaw']))
    expect(texts().filter((text) => text === TITLE)).toHaveLength(2)

    act(() => root.findByProps({ accessibilityLabel: 'Close details' }).props.onPress())
    expect(root.findAllByType('Modal')).toHaveLength(0)
  })
})
