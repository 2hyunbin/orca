// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { parse } from 'acorn'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const source = readFileSync(
  process.env.ORCA_LIST_WEB_SOURCE_PATH ??
    join(dirname(require.resolve('@legendapp/list/react-native')), 'react-native.web.js'),
  'utf8'
)
const parsed = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
function declaration(name: string): string {
  const node = parsed.body.find((entry) =>
    entry.type === 'FunctionDeclaration'
      ? entry.id?.name === name
      : entry.type === 'VariableDeclaration' &&
        entry.declarations.some((value) => value.id.type === 'Identifier' && value.id.name === name)
  )
  if (!node) {
    throw new Error(`Missing pinned web declaration ${name}`)
  }
  return source.slice(node.start, node.end)
}

let root: Root | undefined
let host: HTMLElement | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  host?.remove()
  vi.useRealTimers()
})

async function mount() {
  vi.useFakeTimers()
  const begin = vi.fn()
  const end = vi.fn()
  const scroll = vi.fn()
  const ctx = { state: { props: {}, didFinishInitialScroll: true } }
  const functions = [
    'getContentSize2',
    'getScrollContentSize',
    'getLayoutMeasurement',
    'clampOffset',
    'getAxisSize',
    'getMaxOffset',
    'resolveScrollableNode',
    'resolveScrollEventTarget',
    'getContentInsetEndAdjustmentEnd2',
    'getFiniteSnapOffsets',
    'useRafCoalescer'
  ]
  const context = {
    React3: React,
    React3__namespace: React,
    useStateContext: () => ctx,
    useArr$: () => [0],
    useLatestRef: (value: unknown) => {
      const ref = React.useRef(value)
      React.useLayoutEffect(() => {
        ref.current = value
      }, [value])
      return ref
    },
    StyleSheet: { flatten: (value: unknown) => value || {} },
    SCROLL_END_FALLBACK_MS: 200,
    LEGEND_LIST_CONTENT_CONTAINER_CLASS: 'legend-list-content-container',
    LEGEND_LIST_SCROLLBAR_X_HIDDEN_CLASS: 'hidden-x',
    LEGEND_LIST_SCROLLBAR_Y_HIDDEN_CLASS: 'hidden-y',
    IS_DEV: false,
    isInMVCPActiveMode: () => true,
    requestAnimationFrame: (callback: FrameRequestCallback) => requestAnimationFrame(callback),
    cancelAnimationFrame: (id: number) => cancelAnimationFrame(id),
    setTimeout: (callback: () => void, duration: number) => setTimeout(callback, duration),
    clearTimeout: (id: number) => clearTimeout(id),
    window,
    document
  }
  const Component = runInNewContext(
    functions.map(declaration).join('\n') +
      '\n' +
      declaration('ListComponentScrollView') +
      '\nListComponentScrollView',
    context
  )
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      React.createElement(
        Component,
        {
          onScroll: scroll,
          onInternalScrollEnd: vi.fn(),
          onMomentumScrollBegin: begin,
          onMomentumScrollEnd: end,
          tabIndex: 0
        },
        React.createElement(
          'div',
          null,
          React.createElement('input'),
          React.createElement('button', null, 'Button'),
          React.createElement('a', { href: '#' }, 'Link'),
          React.createElement('p', null, 'Selectable words')
        )
      )
    )
  )
  const scroller = host.firstElementChild
  const content = scroller?.firstElementChild
  if (!(scroller instanceof HTMLElement) || !(content instanceof HTMLElement)) {
    throw new Error('No actual web scroller')
  }
  Object.defineProperties(scroller, {
    clientHeight: { value: 500 },
    clientWidth: { value: 800 },
    scrollHeight: { value: 2000 },
    scrollWidth: { value: 815 }
  })
  Object.defineProperties(content, { scrollHeight: { value: 2000 }, scrollWidth: { value: 800 } })
  scroller.scrollTop = 900
  return { scroller, begin, end, scroll }
}

// Runs the shipped DOM scroller component with synthetic dimensions, not an inert list mock.
describe('pinned web list input bridge', () => {
  it('separates programmatic scroll from wheel ownership and ends with the existing metrics', async () => {
    const list = await mount()
    await act(async () => list.scroller.dispatchEvent(new Event('scroll')))
    expect(list.begin).not.toHaveBeenCalled()
    await act(async () =>
      list.scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -30, bubbles: true }))
    )
    expect(list.begin).toHaveBeenCalledOnce()
    expect(list.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeEvent: expect.objectContaining({ contentOffset: { x: 0, y: 900 } })
      })
    )
    list.scroller.scrollTop = 870
    await act(async () => {
      list.scroller.dispatchEvent(new Event('scroll'))
      list.scroller.dispatchEvent(new Event('scrollend'))
      vi.advanceTimersByTime(200)
    })
    expect(list.end).toHaveBeenCalledOnce()
    expect(list.end).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeEvent: expect.objectContaining({ contentOffset: { x: 0, y: 870 } })
      })
    )
  })
  it('takes keyboard, touch motion and scrollbar input, while ordinary mouse text selection stays untouched', async () => {
    const list = await mount()
    await act(async () =>
      list.scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
    )
    expect(list.begin).toHaveBeenCalledOnce()
    await act(async () => vi.advanceTimersByTime(200))
    const paragraph = list.scroller.querySelector('p')!
    await act(async () => {
      paragraph.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerType: 'mouse',
          pointerId: 1,
          clientY: 200,
          bubbles: true
        })
      )
      paragraph.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerType: 'mouse',
          pointerId: 1,
          clientY: 100,
          bubbles: true
        })
      )
    })
    expect(list.begin).toHaveBeenCalledOnce()
    await act(async () => {
      paragraph.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerType: 'touch',
          pointerId: 2,
          clientY: 200,
          bubbles: true
        })
      )
      paragraph.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerType: 'touch',
          pointerId: 2,
          clientY: 250,
          bubbles: true
        })
      )
    })
    expect(list.begin).toHaveBeenCalledTimes(2)
    await act(async () => vi.advanceTimersByTime(200))
    await act(async () =>
      list.scroller.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerType: 'mouse',
          pointerId: 3,
          button: 0,
          clientX: 805,
          bubbles: true
        })
      )
    )
    expect(list.begin).toHaveBeenCalledTimes(3)
  })
  it('ignores browser zoom, editable controls and keyboard activation of buttons or links', async () => {
    const list = await mount()
    await act(async () => {
      const zoom = new WheelEvent('wheel', { deltaY: -30, bubbles: true })
      Object.defineProperty(zoom, 'ctrlKey', { value: true })
      list.scroller.dispatchEvent(zoom)
      list.scroller
        .querySelector('input')
        ?.dispatchEvent(new WheelEvent('wheel', { deltaY: -30, bubbles: true }))
      list.scroller
        .querySelector('input')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      list.scroller
        .querySelector('button')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      list.scroller
        .querySelector('a')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(list.begin).not.toHaveBeenCalled()
  })
  it('bounds no-motion input and pointer cancellation with the existing end fallback', async () => {
    const list = await mount()
    await act(async () =>
      list.scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -30, bubbles: true }))
    )
    await act(async () => vi.advanceTimersByTime(200))
    expect(list.end).toHaveBeenCalledOnce()
    expect(list.end).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeEvent: expect.objectContaining({ contentOffset: { x: 0, y: 900 } })
      })
    )
    list.scroller.scrollTop = 1500
    await act(async () =>
      list.scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 30, bubbles: true }))
    )
    expect(list.begin).toHaveBeenCalledOnce()
    await act(async () => {
      list.scroller.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerType: 'touch',
          pointerId: 2,
          clientY: 200,
          bubbles: true
        })
      )
      list.scroller.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerType: 'touch',
          pointerId: 2,
          clientY: 250,
          bubbles: true
        })
      )
      list.scroller.dispatchEvent(
        new PointerEvent('pointercancel', { pointerType: 'touch', pointerId: 2, bubbles: true })
      )
      vi.advanceTimersByTime(200)
    })
    expect(list.begin).toHaveBeenCalledTimes(2)
    expect(list.end).toHaveBeenCalledTimes(2)
  })
  it('removes input listeners and the existing scroll-end fallback on disposal', async () => {
    const list = await mount()
    await act(async () =>
      list.scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -30, bubbles: true }))
    )
    await act(async () => root?.unmount())
    root = undefined
    await act(async () => {
      list.scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -30, bubbles: true }))
      vi.advanceTimersByTime(500)
    })
    expect(list.begin).toHaveBeenCalledOnce()
    expect(list.end).not.toHaveBeenCalled()
  })
})
