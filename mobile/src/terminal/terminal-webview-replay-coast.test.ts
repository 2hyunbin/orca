// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { terminalDocumentDouble } from './document/document-terminal-double.test-support'
import { TERMINAL_DOCUMENT_SCRIPT } from './terminal-webview-document-script.generated'
import { TERMINAL_DOCUMENT_MARKUP } from './terminal-webview-html'

describe('snapshot replacement ends the previous terminal scroll', () => {
  let now: number
  let nextFrame: number
  let frames: Map<number, FrameRequestCallback>
  let scrolls: number[]
  let inputs: string[]
  let alternate: boolean
  let messages: Array<{ type: string; enabled?: boolean }>
  let oldSurface: HTMLElement

  function frame() {
    now += 16
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((callback) => callback(now))
  }

  function settle() {
    for (let count = 0; count < 20 && frames.size; count++) {
      frame()
    }
  }

  function init(preserveScroll = false) {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'init',
          cols: 40,
          rows: 24,
          initialData: alternate ? '\x1b[?1049h\x1b[?1000h\x1b[?1006h' : '',
          preserveScroll
        })
      })
    )
  }

  function touch(type: string, y: number, surface = oldSurface) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'touches', {
      value:
        type === 'touchend' ? [] : [{ identifier: 0, clientX: 40, clientY: y, target: surface }]
    })
    Object.defineProperty(event, 'timeStamp', { value: now })
    surface.dispatchEvent(event)
  }

  function boot(program: boolean) {
    alternate = program
    document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
    new Function(TERMINAL_DOCUMENT_SCRIPT)()
    init()
    settle()
    oldSurface = document.getElementById('terminal-surface')!
    if (program) {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'write', data: '\x1b[?1000h\x1b[?1006h' })
        })
      )
    }
    settle()
    scrolls.length = 0
    inputs.length = 0
  }

  function fling() {
    touch('touchstart', 400)
    for (let step = 1; step <= 4; step++) {
      now += 16
      touch('touchmove', 400 - step * 25)
      frame()
    }
    touch('touchend', 300)
    frame()
    expect(alternate ? inputs.length : scrolls.length).toBeGreaterThan(0)
    scrolls.length = 0
    inputs.length = 0
  }

  beforeEach(() => {
    now = 1000
    nextFrame = 1
    frames = new Map()
    scrolls = []
    inputs = []
    alternate = false
    messages = []
    vi.spyOn(window, 'addEventListener')
    vi.spyOn(document, 'addEventListener')
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrame++
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 381 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 612 })
    Object.assign(window, {
      ReactNativeWebView: {
        postMessage(raw: string) {
          const msg = JSON.parse(raw)
          messages.push(msg)
          if (msg.type === 'terminal-input') {
            inputs.push(msg.bytes)
          }
        }
      },
      Terminal: function () {
        const buffer = {
          baseY: 1000,
          viewportY: 500,
          type: alternate ? 'alternate' : 'normal',
          cursorY: 0,
          length: 1000,
          getLine: () => undefined
        }
        let element: HTMLElement | undefined
        return {
          ...terminalDocumentDouble().terminal,
          cols: 40,
          rows: 24,
          modes: { mouseTrackingMode: alternate ? 'vt200' : 'none' },
          _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 15 } } } } },
          buffer: { active: buffer },
          get element() {
            return element
          },
          open(surface: HTMLElement) {
            element = surface
          },
          scrollLines(rows: number) {
            buffer.viewportY += rows
            scrolls.push(rows)
          },
          setViewportPixelOffset() {
            return true
          }
        }
      }
    })
  })

  afterEach(() => {
    for (const [type, listener, options] of vi.mocked(window.addEventListener).mock.calls) {
      window.removeEventListener(type, listener, options)
    }
    for (const [type, listener, options] of vi.mocked(document.addEventListener).mock.calls) {
      document.removeEventListener(type, listener, options)
    }
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true]
  ])(
    'does not coast into the replacement (program=%s, preserveScroll=%s)',
    (program, preserveScroll) => {
      boot(program)
      fling()
      init(preserveScroll)
      settle()
      expect(inputs).toEqual([])
      expect(scrolls).toEqual([])
    }
  )

  it('drops an unpainted normal-buffer drag when the snapshot is replaced', () => {
    boot(false)
    touch('touchstart', 400)
    now += 16
    touch('touchmove', 360)
    expect(scrolls).toEqual([])
    init(true)
    settle()
    expect(scrolls).toEqual([])
  })

  it('ignores movement from a finger on the retired surface', () => {
    boot(false)
    touch('touchstart', 400)
    init(true)
    settle()
    now += 16
    touch('touchmove', 360)
    settle()
    touch('touchend', 360)
    settle()
    expect(scrolls).toEqual([])
  })

  it('cancels a pending long press when its terminal is replaced', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    boot(false)
    touch('touchstart', 400)
    init()
    settle()
    messages.length = 0
    vi.advanceTimersByTime(500)
    expect(
      messages.filter((message) => message.type === 'set-select-mode' && message.enabled)
    ).toEqual([])
  })

  it('does not launch an old finger’s velocity after snapshot replacement', () => {
    boot(false)
    touch('touchstart', 400)
    now += 16
    touch('touchmove', 360)
    frame()
    init(true)
    settle()
    scrolls.length = 0
    touch('touchend', 360)
    settle()
    expect(scrolls).toEqual([])
  })

  it.each([false, true])('still accepts a new fling after replacement (program=%s)', (program) => {
    boot(program)
    fling()
    init()
    settle()
    oldSurface = document.getElementById('terminal-surface')!
    if (program) {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'write', data: '\x1b[?1000h\x1b[?1006h' })
        })
      )
    }
    settle()
    scrolls.length = 0
    inputs.length = 0
    fling()
    for (let count = 0; count < 4; count++) {
      frame()
    }
    expect(alternate ? inputs.length : scrolls.length).toBeGreaterThan(0)
  })
})
