import { Animated, View } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { assert, expect, it, vi } from 'vitest'
import { MobileSessionTitleBlock } from './MobileSessionTitleBlock'
import { useSessionTitleCard } from './use-session-title-card'
import { AnchoredDetailCard } from '../components/AnchoredDetailCard'

const overlay = vi.hoisted(
  (): {
    width: number
    height: number
    back: (() => boolean) | null
    finish: (() => void) | null
    measure: (() => void) | null
    defer: boolean
  } => ({ width: 667, height: 375, back: null, finish: null, measure: null, defer: false })
)
vi.mock('../layout/side-safe-area', () => ({
  useWindowSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('../navigation/use-back-claim', async () => {
  const { useEffect } = await import('react')
  return {
    useBackClaim: (claim: () => boolean) =>
      useEffect(() => {
        overlay.back = claim
        return () => {
          overlay.back = null
        }
      }, [claim])
  }
})

vi.mock('react-native', () => {
  class Value {
    interpolate() {
      return this
    }
  }
  return {
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Platform: { OS: 'ios', select: (choices: { ios?: string }) => choices.ios },
    StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
    useWindowDimensions: () => ({ width: overlay.width, height: overlay.height }),
    Easing: { out: () => () => 0, cubic: () => 0 },
    Animated: {
      View: 'AnimatedView',
      Value,
      timing: (_value: unknown, config: { toValue: number }) => {
        let stopped = false
        return {
          start: (done: (result: { finished: boolean }) => void) => {
            if (config.toValue === 0) {
              overlay.finish = () => done({ finished: !stopped })
            } else {
              done({ finished: true })
            }
          },
          stop: () => {
            stopped = true
          }
        }
      }
    }
  }
})
vi.mock('../platform/use-reduced-motion', () => ({ useReducedMotionEnabled: () => false }))

function Fixture() {
  const details = useSessionTitleCard(true, false)
  return (
    <View>
      <View ref={details.barRef}>
        <MobileSessionTitleBlock
          title="workspace"
          connState="connected"
          details={details}
          meta=""
          showConnectionRetry={false}
          onRetry={() => {}}
        />
      </View>
      <View ref={details.layerRef} testID="layer" onLayout={details.onLayout}>
        {details.anchor ? (
          <AnchoredDetailCard
            {...details}
            anchor={details.anchor}
            onDismiss={details.dismiss}
            title="workspace"
          />
        ) : null}
      </View>
    </View>
  )
}

it('retains one title target through reversal and completion, with root-relative geometry and Back', () => {
  let titleWidth = 40
  const mounted: { renderer?: ReactTestRenderer } = {}
  act(() => {
    mounted.renderer = create(<Fixture />, {
      createNodeMock: (node) => ({
        measureInWindow: (done: (x: number, y: number, w: number, h: number) => void) => {
          const isLayer =
            node.props !== null && typeof node.props === 'object' && 'testID' in node.props
          const measure = () => (isLayer ? done(20, 10, 627, 365) : done(80, 20, titleWidth, 45))
          if (overlay.defer && isLayer) {
            overlay.measure = measure
          } else {
            measure()
          }
        }
      })
    })
  })
  const renderer = mounted.renderer
  assert(renderer)
  const root = renderer.root
  const layout = (width: number, height: number) =>
    root
      .findByProps({ testID: 'layer' })
      .props.onLayout({ nativeEvent: { layout: { width, height } } })
  const opener = root.findByProps({
    accessibilityHint: 'Shows the full workspace name and where it is'
  })
  const card = () => root.findByType(Animated.View)
  act(() => layout(627, 365))
  act(() => opener.props.onPress())
  expect(card().props.style[1]).toMatchObject({ left: 60, top: 55, width: 256, maxHeight: 302 })
  act(() => root.findAllByProps({ accessible: false })[0]?.props.onPress())
  const cancelled = overlay.finish
  act(() => opener.props.onPress())
  act(() => cancelled?.())
  expect(root.findAllByType(AnchoredDetailCard)).toHaveLength(1)
  act(() => opener.props.onPress())
  overlay.defer = true
  act(() => opener.props.onPress())
  act(() => overlay.finish?.())
  expect(root.findAllByType(AnchoredDetailCard)).toHaveLength(0)
  act(() => overlay.measure?.())
  overlay.defer = false
  expect(root.findByProps({ accessibilityHint: opener.props.accessibilityHint })).toBe(opener)
  overlay.height = 300
  act(() => {
    renderer.update(<Fixture />)
    layout(627, 290)
  })
  expect(card().props.style[1].maxHeight).toBe(227)
  titleWidth = 160
  act(() => opener.props.onLayout())
  expect(root.findAllByProps({ accessible: false })[3]?.props.style.left).toBe(220)
  act(() => opener.props.onPress())
  expect(root.findByType(AnchoredDetailCard).props.open).toBe(true)
  overlay.width = 375
  act(() => renderer.update(<Fixture />))
  act(() => expect(overlay.back?.()).toBe(true))
  act(() => overlay.finish?.())
  expect(overlay.back).toBeNull()
  act(() => renderer.unmount())
})
