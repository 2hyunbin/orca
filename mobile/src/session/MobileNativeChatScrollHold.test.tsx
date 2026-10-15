import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatScrollHold } from './MobileNativeChatScrollHold'

const platform = vi.hoisted(() => ({ OS: 'web' }))

vi.mock('react-native', () => ({ Platform: platform }))

type Row = {
  isConnected: boolean
  children: Row[]
  getBoundingClientRect: () => { top: number; bottom: number }
}

/** Whether the update under test is in the document yet: from the scroller's second read on, the
 *  first being the snapshot taken before it. */
let landed = false

/** A row 100 tall whose top is `before` until the update lands, then `after`. */
function row(before: number, after = before, children: Row[] = []): Row {
  return {
    isConnected: true,
    children,
    getBoundingClientRect: () => {
      const top = landed ? after : before
      return { top, bottom: top + 100 }
    }
  }
}

/** A 600 tall view, 40 from the top of its content, over the given header block and list rows. */
function scrollerOver(headerRows: Row[], listRows: Row[], scrollTop = 40) {
  const node = {
    scrollTop,
    scrollHeight: 3_500,
    clientHeight: 600,
    getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
    firstElementChild: row(-40, -40, [row(-40, -40, headerRows), ...listRows])
  }
  let reads = 0
  const getScrollableNode = () => {
    landed = reads > 0
    reads += 1
    return node
  }
  return { node, listRef: { current: { getScrollableNode } } }
}

describe('MobileNativeChatScrollHold', () => {
  let renderer: ReactTestRenderer | null = null

  async function show(
    headKey: string,
    listRef: ReturnType<typeof scrollerOver>['listRef'],
    loadEarlier = false
  ) {
    const props = { headKey, header: true, loadEarlier, footer: false, listRef }
    await act(async () => {
      const element = createElement(MobileNativeChatScrollHold, props)
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    landed = false
    platform.OS = 'web'
  })

  it('moves by what landed above the reader, not by live output landing below it too', async () => {
    const { node, listRef } = scrollerOver([], [row(100, 2_100), row(300, 2_300), row(500, 3_000)])
    await show('a', listRef)

    await show('older', listRef)

    expect(node.scrollTop).toBe(2_040)
  })

  it('holds a message, not the Load earlier control, even as the final page drops it', async () => {
    const { node, listRef } = scrollerOver([row(0), row(100, 2_100)], [row(900, 2_900)])
    await show('a', listRef, true)

    await show('older', listRef, false)

    expect(node.scrollTop).toBe(2_040)
  })

  it('holds the next message on screen when a trim removes the first', async () => {
    const trimmed = row(100)
    const { node, listRef } = scrollerOver([], [trimmed, row(300, 200)], 400)
    await show('a', listRef)
    trimmed.isConnected = false

    await show('b', listRef)

    expect(node.scrollTop).toBe(300)
  })

  it('leaves the view to iOS while it bounces the list past the top', async () => {
    const { node, listRef } = scrollerOver([], [row(100, 2_100)], -15)
    await show('a', listRef)

    await show('older', listRef)

    expect(node.scrollTop).toBe(-15)
  })

  it('leaves the view alone while the first row is the same', async () => {
    const { node, listRef } = scrollerOver([], [row(300, 2_300)])
    await show('a', listRef)

    await show('a', listRef)

    expect(node.scrollTop).toBe(40)
  })

  it('does nothing in a native build, where the list holds its own place', async () => {
    platform.OS = 'ios'
    const { node, listRef } = scrollerOver([], [row(300, 2_300)])
    await show('a', listRef)

    await show('older', listRef)

    expect(node.scrollTop).toBe(40)
  })
})
