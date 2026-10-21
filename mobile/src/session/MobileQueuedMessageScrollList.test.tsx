import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { LayoutRectangle } from 'react-native'
import { afterEach, expect, it, vi } from 'vitest'
import { spacing } from '../theme/mobile-theme'
import { MobileQueuedMessageScrollList } from './MobileQueuedMessageScrollList'

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View'
}))

let mounted: ReactTestRenderer | undefined

afterEach(() => {
  act(() => mounted?.unmount())
})

it.each([
  { height: 120, contentFirst: true },
  { height: 120, contentFirst: false },
  { height: 220, contentFirst: true },
  { height: 220, contentFirst: false }
])(
  'reveals the whole $height pt editor as list dimensions settle ($contentFirst)',
  async ({ height, contentFirst }) => {
    let reveal: ((row: LayoutRectangle) => void) | undefined
    let viewport = 160
    let content = 400
    let offset = 200
    const scrollTo = vi.fn(({ y }: { y: number }) => {
      // WebKit clamps a scroll issued before its new content/viewport dimensions arrive.
      offset = Math.max(0, Math.min(y, content - viewport))
      scroll().props.onScroll({ nativeEvent: { contentOffset: { y: offset } } })
    })
    await act(async () => {
      mounted = create(createElement('View'), {
        createNodeMock: (element) =>
          element.type === 'ScrollView' ? { scrollTo, flashScrollIndicators: vi.fn() } : null
      })
    })
    const show = async (editingMessageId?: string) => {
      await act(async () =>
        mounted?.update(
          <MobileQueuedMessageScrollList
            messageIds={['a', 'b', 'c']}
            newestIsPersons={false}
            editingMessageId={editingMessageId}
          >
            {(nextReveal) => {
              reveal = nextReveal
              return null
            }}
          </MobileQueuedMessageScrollList>
        )
      )
    }
    function scroll() {
      return mounted!.root.find((node) => String(node.type) === 'ScrollView')
    }
    await show('b')
    await act(async () => {
      scroll().props.onLayout({ nativeEvent: { layout: { height: viewport } } })
      scroll().props.onContentSizeChange(0, content)
      scroll().props.onScroll({ nativeEvent: { contentOffset: { y: offset } } })
    })
    const row = { x: 0, y: 220, width: 360, height }
    await act(async () => reveal?.(row))
    const maxHeight = Math.max(160, height + 2 * spacing.lg)
    expect(scroll().props.style.maxHeight).toBe(maxHeight)
    const resize = async (dimension: 'content' | 'viewport') => {
      await act(async () => {
        if (dimension === 'content') {
          content = row.y + row.height + 100
          scroll().props.onContentSizeChange(0, content)
        } else {
          viewport = maxHeight
          scroll().props.onLayout({ nativeEvent: { layout: { height: viewport } } })
        }
      })
    }
    await resize(contentFirst ? 'content' : 'viewport')
    await resize(contentFirst ? 'viewport' : 'content')
    expect(offset).toBeLessThanOrEqual(row.y - spacing.lg)
    expect(offset + viewport).toBeGreaterThanOrEqual(row.y + row.height + spacing.lg)
    // Reading elsewhere is still allowed; scroll events alone never pull the editor back.
    scrollTo.mockClear()
    await act(async () => scroll().props.onScroll({ nativeEvent: { contentOffset: { y: 0 } } }))
    await resize('content')
    expect(scrollTo).not.toHaveBeenCalled()
    await show()
    await show('b')
    expect(scroll().props.style.maxHeight).toBe(160)
  }
)
