import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { events, sourceFrames } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return { events: new EventEmitter(), sourceFrames: new WeakMap<object, unknown>() }
})
vi.mock('electron', () => ({
  app: events,
  webContents: { fromFrame: (frame: object) => sourceFrames.get(frame) }
}))

import {
  allowNativeBrowserPopup,
  isNativeBrowserPopupRequest,
  prepareNativeBrowserPopup,
  rejectOverlappingNativeBrowserPopup
} from './browser-popup-native-window'

const fixtureOpeners = new Set<ReturnType<typeof nativeWindow>>()

afterEach(() => {
  for (const opener of fixtureOpeners) {
    opener.contents.emit('destroyed')
  }
  fixtureOpeners.clear()
  events.removeAllListeners()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

function nativeWindow() {
  const contents = Object.assign(new EventEmitter(), {
    session: {},
    mainFrame: { url: '', origin: 'null', isDestroyed: vi.fn(() => false) },
    opener: undefined,
    isDestroyed: vi.fn(() => false),
    close: vi.fn(),
    stop: vi.fn(),
    setWindowOpenHandler: vi.fn()
  })
  Object.assign(contents.mainFrame, { top: contents.mainFrame })
  sourceFrames.set(contents.mainFrame, contents)
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: vi.fn(() => false),
    setTitle: vi.fn(),
    showInactive: vi.fn(),
    show: vi.fn(),
    destroy: vi.fn()
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture implements every BrowserWindow member exercised by popup preparation.
  const browserWindow = window as unknown as Electron.BrowserWindow
  const fixture = { window, contents, browserWindow }
  fixtureOpeners.add(fixture)
  return fixture
}

function announceScriptedChild(
  opener: ReturnType<typeof nativeWindow>,
  child: ReturnType<typeof nativeWindow>
): void {
  Object.defineProperty(child.contents, 'opener', {
    value: opener.contents.mainFrame,
    configurable: true
  })
  events.emit('web-contents-created', {}, child.contents)
}

describe('native popup admission', () => {
  it('uses the native path only for observed unnamed, featureless OpenURL dispositions', () => {
    for (const disposition of ['new-window', 'background-tab']) {
      expect(isNativeBrowserPopupRequest({ disposition, features: '', frameName: '' })).toBe(true)
      expect(
        isNativeBrowserPopupRequest({ disposition, features: 'width=500', frameName: '' })
      ).toBe(false)
      expect(isNativeBrowserPopupRequest({ disposition, features: '', frameName: 'oauth' })).toBe(
        false
      )
    }
    for (const details of [
      { disposition: 'foreground-tab', features: '', frameName: '' },
      { disposition: 'new-window', features: 'width=500', frameName: '' },
      { disposition: 'new-window', features: '', frameName: 'oauth' },
      {}
    ]) {
      expect(isNativeBrowserPopupRequest(details)).toBe(false)
    }
  })

  it('leaves request continuation to Electron, with hidden construction and no custom callback', () => {
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
    const opener = nativeWindow().browserWindow.webContents
    const response = allowNativeBrowserPopup({
      opener,
      options: { show: true, frame: true },
      onCreated: vi.fn()
    })
    expect(response.createWindow).toBeUndefined()
    expect(response.overrideBrowserWindowOptions).toMatchObject({
      show: false,
      fullscreenable: false,
      title: 'about:blank',
      useContentSize: true,
      minWidth: 360,
      minHeight: 200,
      webPreferences: { session: opener.session }
    })
  })

  it('binds a scripted child by actual contents instead of delivered constructor options', async () => {
    const opener = nativeWindow()
    const child = nativeWindow()
    child.contents.session = opener.contents.session
    const onCreated = vi.fn()
    allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: { show: false },
      onCreated
    })
    announceScriptedChild(opener, child)
    await Promise.resolve()
    events.emit('browser-window-created', {}, child.browserWindow)
    opener.contents.emit('did-create-window', child.browserWindow, { options: {} })
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ nativeWindow: child.browserWindow })
    )
    expect(child.contents.close).not.toHaveBeenCalled()
  })

  it('ignores an unrelated app window once the actual script contents are bound', () => {
    const opener = nativeWindow()
    const child = nativeWindow()
    const unrelated = nativeWindow()
    child.contents.session = unrelated.contents.session = opener.contents.session
    const onCreated = vi.fn()
    allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: {},
      onCreated
    })
    announceScriptedChild(opener, child)
    events.emit('browser-window-created', {}, unrelated.browserWindow)
    expect(onCreated).not.toHaveBeenCalled()
    expect(unrelated.contents.close).not.toHaveBeenCalled()
    events.emit('browser-window-created', {}, child.browserWindow)
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ nativeWindow: child.browserWindow })
    )
  })

  it('blocks an original navigation while window delivery is held and rejects it without replay', async () => {
    const opener = nativeWindow()
    const child = nativeWindow()
    child.contents.session = opener.contents.session
    const onCreated = vi.fn()
    allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: {},
      onCreated
    })
    announceScriptedChild(opener, child)
    await Promise.resolve()
    const preventDefault = vi.fn()
    child.contents.emit('will-frame-navigate', { preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    events.emit('browser-window-created', {}, child.browserWindow)
    expect(onCreated).not.toHaveBeenCalled()
    expect(child.contents.close).toHaveBeenCalledOnce()
    expect(rejectOverlappingNativeBrowserPopup(opener.browserWindow.webContents)).toBe(false)
  })

  it('fences another creation path until its canceled original is confirmed destroyed', () => {
    const opener = nativeWindow()
    const child = nativeWindow()
    expect(rejectOverlappingNativeBrowserPopup(opener.browserWindow.webContents)).toBe(false)
    allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: {},
      onCreated: vi.fn()
    })
    announceScriptedChild(opener, child)
    expect(rejectOverlappingNativeBrowserPopup(opener.browserWindow.webContents)).toBe(true)
    expect(child.contents.close).toHaveBeenCalledOnce()
    expect(rejectOverlappingNativeBrowserPopup(opener.browserWindow.webContents)).toBe(true)
    child.contents.emit('destroyed')
    expect(rejectOverlappingNativeBrowserPopup(opener.browserWindow.webContents)).toBe(false)
  })

  it('closes bound A and denies B when delivery overlaps instead of trusting B’s staged options', async () => {
    const opener = nativeWindow()
    const child = nativeWindow()
    child.contents.session = opener.contents.session
    const onA = vi.fn()
    const onB = vi.fn()
    allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: { show: false },
      onCreated: onA
    })
    announceScriptedChild(opener, child)
    await Promise.resolve()
    expect(
      allowNativeBrowserPopup({
        opener: opener.browserWindow.webContents,
        options: { show: false },
        onCreated: onB
      })
    ).toEqual({ action: 'deny' })
    expect(child.contents.close).toHaveBeenCalledOnce()
    // Even a deliberately late notification cannot revive either captured callback.
    events.emit('browser-window-created', {}, child.browserWindow)
    opener.contents.emit('did-create-window', child.browserWindow, { options: {} })
    expect(onA).not.toHaveBeenCalled()
    expect(onB).not.toHaveBeenCalled()
  })

  it.each([0, 30_001])(
    'retains an unresolved original instead of lending B to late A after %s ms',
    async (delay) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const opener = nativeWindow()
      const late = nativeWindow()
      late.contents.session = opener.contents.session
      const onA = vi.fn()
      const onB = vi.fn()
      allowNativeBrowserPopup({
        opener: opener.browserWindow.webContents,
        options: { show: false },
        onCreated: onA
      })
      await Promise.resolve()
      vi.advanceTimersByTime(delay)
      expect(
        allowNativeBrowserPopup({
          opener: opener.browserWindow.webContents,
          options: { show: false },
          onCreated: onB
        })
      ).toEqual({ action: 'deny' })
      announceScriptedChild(opener, late)
      events.emit('browser-window-created', {}, late.browserWindow)
      opener.contents.emit('did-create-window', late.browserWindow, { options: {} })
      expect(onA).not.toHaveBeenCalled()
      expect(onB).not.toHaveBeenCalled()
      expect(late.contents.close).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('recovers an unbound admission only after its original source frame is destroyed', () => {
    const opener = nativeWindow()
    const originalDocument = opener.contents.mainFrame
    const onA = vi.fn()
    const onB = vi.fn()
    const a = allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: {},
      onCreated: onA
    })
    expect(rejectOverlappingNativeBrowserPopup(opener.browserWindow.webContents)).toBe(true)
    originalDocument.isDestroyed.mockReturnValue(true)
    Object.assign(opener.contents, { mainFrame: nativeWindow().contents.mainFrame })
    sourceFrames.set(opener.contents.mainFrame, opener.contents)
    expect(rejectOverlappingNativeBrowserPopup(opener.browserWindow.webContents)).toBe(false)
    const b = allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: {},
      onCreated: onB
    })
    const late = nativeWindow()
    late.contents.session = opener.contents.session
    opener.contents.emit('did-create-window', late.browserWindow, {
      options: a.overrideBrowserWindowOptions
    })
    expect(onA).not.toHaveBeenCalled()
    expect(onB).not.toHaveBeenCalled()
    const valid = nativeWindow()
    valid.contents.session = opener.contents.session
    opener.contents.emit('did-create-window', valid.browserWindow, {
      options: b.overrideBrowserWindowOptions
    })
    expect(onB).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ nativeWindow: valid.browserWindow })
    )
  })

  it('can admit B after the bound actual child of A is destroyed', async () => {
    const opener = nativeWindow()
    const first = nativeWindow()
    const second = nativeWindow()
    second.contents.session = opener.contents.session
    const onA = vi.fn()
    const onB = vi.fn()
    allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: {},
      onCreated: onA
    })
    announceScriptedChild(opener, first)
    first.contents.emit('destroyed')
    await Promise.resolve()
    allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: {},
      onCreated: onB
    })
    announceScriptedChild(opener, second)
    events.emit('browser-window-created', {}, second.browserWindow)
    opener.contents.emit('did-create-window', second.browserWindow)
    expect(onA).not.toHaveBeenCalled()
    expect(onB).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ nativeWindow: second.browserWindow })
    )
  })

  it('rejects an unbound scripted child without consuming the actual bound child', async () => {
    const opener = nativeWindow()
    const unbound = nativeWindow()
    const valid = nativeWindow()
    unbound.contents.session = valid.contents.session = opener.contents.session
    const onCreated = vi.fn()
    allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: {},
      onCreated
    })
    announceScriptedChild(opener, valid)
    await Promise.resolve()
    opener.contents.emit('did-create-window', unbound.browserWindow)
    expect(onCreated).not.toHaveBeenCalled()
    expect(unbound.contents.close).toHaveBeenCalledOnce()
    for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
      const preventDefault = vi.fn()
      unbound.contents.emit(event, { preventDefault })
      expect(preventDefault).toHaveBeenCalledOnce()
    }
    events.emit('browser-window-created', {}, valid.browserWindow)
    opener.contents.emit('did-create-window', valid.browserWindow)
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ nativeWindow: valid.browserWindow })
    )
  })

  it('uses no expiration timer and cleans up when the opener is destroyed', () => {
    vi.useFakeTimers()
    const opener = nativeWindow()
    const child = nativeWindow()
    allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: {},
      onCreated: vi.fn()
    })
    announceScriptedChild(opener, child)
    expect(vi.getTimerCount()).toBe(0)
    opener.contents.emit('destroyed')
    expect(child.contents.stop).toHaveBeenCalledOnce()
    expect(child.contents.close).toHaveBeenCalledOnce()
    expect(opener.contents.listenerCount('did-create-window')).toBe(0)
  })

  it('prepares a native child only for its own opener and request', () => {
    const first = nativeWindow()
    const second = nativeWindow()
    const child = nativeWindow()
    second.contents.session = first.contents.session
    child.contents.session = first.contents.session
    const onFirst = vi.fn(() => child.browserWindow.webContents)
    const onSecond = vi.fn(() => child.browserWindow.webContents)
    const responses: Electron.WindowOpenHandlerResponse[] = []
    for (const [opener, onCreated] of [
      [first.browserWindow.webContents, onFirst],
      [second.browserWindow.webContents, onSecond]
    ] as const) {
      responses.push(
        allowNativeBrowserPopup({
          opener,
          options: { show: false },
          onCreated
        })
      )
    }
    events.emit('browser-window-created', {}, child.browserWindow)
    expect(onFirst).not.toHaveBeenCalled()
    expect(onSecond).not.toHaveBeenCalled()
    second.contents.emit('did-create-window', child.browserWindow, {
      options: responses[1].overrideBrowserWindowOptions
    })
    expect(onSecond).toHaveBeenCalledOnce()
    expect(onFirst).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'an unrelated app window receives neither policy nor disposal (same session: %s)',
    async (sameSession) => {
      const opener = nativeWindow()
      const unrelated = nativeWindow()
      if (sameSession) {
        unrelated.contents.session = opener.contents.session
      }
      const onCreated = vi.fn(() => unrelated.browserWindow.webContents)
      allowNativeBrowserPopup({
        opener: opener.browserWindow.webContents,
        options: { show: false },
        onCreated
      })
      events.emit('browser-window-created', {}, unrelated.browserWindow)
      await Promise.resolve()
      expect(onCreated).not.toHaveBeenCalled()
      expect(unrelated.contents.close).not.toHaveBeenCalled()
      expect(unrelated.window.destroy).not.toHaveBeenCalled()
    }
  )

  it('consumes native request identity once and rejects absent, foreign and reused identities', () => {
    const opener = nativeWindow()
    const foreign = nativeWindow()
    const onCreated = vi.fn()
    const response = allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: {},
      onCreated
    })
    const other = allowNativeBrowserPopup({
      opener: foreign.browserWindow.webContents,
      options: {},
      onCreated: vi.fn()
    })
    const deliver = (options: Electron.BrowserWindowConstructorOptions | undefined) => {
      const child = nativeWindow()
      child.contents.session = opener.contents.session
      opener.contents.emit('did-create-window', child.browserWindow, { options })
      return child
    }
    const absent = deliver({})
    const wrong = deliver(other.overrideBrowserWindowOptions)
    expect(onCreated).not.toHaveBeenCalled()
    expect(absent.contents.stop).toHaveBeenCalledOnce()
    expect(wrong.contents.stop).toHaveBeenCalledOnce()
    const original = deliver({ ...response.overrideBrowserWindowOptions })
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ nativeWindow: original.browserWindow })
    )
    const reused = deliver({ ...response.overrideBrowserWindowOptions })
    expect(onCreated).toHaveBeenCalledOnce()
    expect(original.contents.close).not.toHaveBeenCalled()
    expect(reused.contents.stop).toHaveBeenCalledOnce()
  })

  it('does not use stale delivered script options to authorize a late original as its successor', () => {
    const opener = nativeWindow()
    const first = nativeWindow()
    const second = nativeWindow()
    first.contents.session = second.contents.session = opener.contents.session
    const onA = vi.fn()
    const onB = vi.fn()
    allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: {},
      onCreated: onA
    })
    announceScriptedChild(opener, first)
    expect(rejectOverlappingNativeBrowserPopup(opener.browserWindow.webContents)).toBe(true)
    first.contents.emit('destroyed')
    const b = allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: {},
      onCreated: onB
    })
    // Deliberately deliver B's options on A; identity is the concrete child observed earlier.
    opener.contents.emit('did-create-window', first.browserWindow, {
      options: b.overrideBrowserWindowOptions
    })
    expect(onA).not.toHaveBeenCalled()
    expect(onB).not.toHaveBeenCalled()
    announceScriptedChild(opener, second)
    events.emit('browser-window-created', {}, second.browserWindow)
    opener.contents.emit('did-create-window', second.browserWindow, { options: {} })
    expect(onB).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ nativeWindow: second.browserWindow })
    )
  })

  it('never admits a discarded old-document script child through the native options path', () => {
    const opener = nativeWindow()
    const oldDocument = opener.contents.mainFrame
    allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: {},
      onCreated: vi.fn()
    })
    oldDocument.isDestroyed.mockReturnValue(true)
    Object.assign(opener.contents, { mainFrame: nativeWindow().contents.mainFrame })
    sourceFrames.set(opener.contents.mainFrame, opener.contents)
    const onCreated = vi.fn()
    const b = allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: {},
      onCreated
    })
    const late = nativeWindow()
    late.contents.session = opener.contents.session
    Object.defineProperty(late.contents, 'opener', { value: oldDocument, configurable: true })
    events.emit('web-contents-created', {}, late.contents)
    expect(late.contents.stop).toHaveBeenCalledOnce()
    Object.defineProperty(late.contents, 'opener', { value: null })
    opener.contents.emit('did-create-window', late.browserWindow, {
      options: b.overrideBrowserWindowOptions
    })
    expect(onCreated).not.toHaveBeenCalled()
    const valid = nativeWindow()
    valid.contents.session = opener.contents.session
    announceScriptedChild(opener, valid)
    events.emit('browser-window-created', {}, valid.browserWindow)
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ nativeWindow: valid.browserWindow })
    )
  })

  it('handles duplicate did-create-window delivery idempotently for an already marked child', async () => {
    const opener = nativeWindow()
    const child = nativeWindow()
    child.contents.session = opener.contents.session
    const onCreated = vi.fn(() => child.browserWindow.webContents)
    const response = allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options: { show: false },
      onCreated
    })
    announceScriptedChild(opener, child)
    await Promise.resolve()
    events.emit('browser-window-created', {}, child.browserWindow)
    for (let delivery = 0; delivery < 2; delivery++) {
      opener.contents.emit('did-create-window', child.browserWindow, {
        options: response.overrideBrowserWindowOptions
      })
    }
    expect(onCreated).toHaveBeenCalledOnce()
    expect(child.contents.close).not.toHaveBeenCalled()
  })

  it.each(['ready', 'background-launch', 'hidden', 'fenced'] as const)(
    'presents foreground children only after safe readiness: %s',
    (state) => {
      vi.stubEnv('ORCA_BACKGROUND_LAUNCH', state === 'background-launch' ? '1' : '0')
      const opener = nativeWindow()
      const child = nativeWindow()
      child.contents.session = opener.contents.session
      const response = allowNativeBrowserPopup({
        opener: opener.browserWindow.webContents,
        options: { show: state !== 'hidden' },
        canPresent: () => state !== 'fenced',
        onCreated: () => child.browserWindow.webContents
      })
      events.emit('browser-window-created', {}, child.browserWindow)
      opener.contents.emit('did-create-window', child.browserWindow, {
        options: response.overrideBrowserWindowOptions
      })
      expect(child.window.show).not.toHaveBeenCalled()
      child.window.emit('ready-to-show')
      expect(child.window.show).toHaveBeenCalledTimes(state === 'ready' ? 1 : 0)
      expect(child.window.showInactive).not.toHaveBeenCalled()
    }
  )

  it.each([
    'ready',
    'background-launch',
    'explicit-hidden',
    'fenced',
    'authority-error',
    'closed',
    'opener-gone',
    'changed-launch',
    'changed-hidden',
    'changed-session',
    'preparation-rejected'
  ])('presents background children only after safe readiness: %s', (state) => {
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', state === 'background-launch' ? '1' : '0')
    const { browserWindow, window, contents } = nativeWindow()
    const opener = nativeWindow()
    contents.session = opener.contents.session
    const options = { show: state !== 'explicit-hidden' }
    const prepare = vi.fn(() =>
      state === 'preparation-rejected'
        ? prepareNativeBrowserPopup(browserWindow, () => false).contentWebContents
        : browserWindow.webContents
    )
    const response = allowNativeBrowserPopup({
      opener: opener.browserWindow.webContents,
      options,
      background: true,
      canPresent: () => {
        if (state === 'authority-error') {
          throw new Error('Synthetic authority failure')
        }
        return state !== 'fenced'
      },
      onCreated: prepare
    })
    expect(response.overrideBrowserWindowOptions?.show).toBe(false)
    events.emit('browser-window-created', {}, browserWindow)
    opener.contents.emit('did-create-window', browserWindow, {
      options: response.overrideBrowserWindowOptions
    })
    expect(prepare).toHaveBeenCalledOnce()
    expect(window.showInactive).not.toHaveBeenCalled()
    if (state === 'closed') {
      window.isDestroyed.mockReturnValue(true)
    }
    if (state === 'opener-gone') {
      opener.contents.isDestroyed.mockReturnValue(true)
    }
    if (state === 'changed-launch') {
      vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
    }
    if (state === 'changed-hidden') {
      options.show = false
    }
    if (state === 'changed-session') {
      contents.session = {}
    }
    window.emit('ready-to-show')
    expect(window.showInactive).toHaveBeenCalledTimes(state === 'ready' ? 1 : 0)
  })

  it.each([
    () => false,
    () => {
      throw new Error('Synthetic failed authority')
    }
  ])('blocks native navigation and descendants when preparation fails', (prepare) => {
    const { browserWindow, contents, window } = nativeWindow()
    const popup = prepareNativeBrowserPopup(browserWindow, prepare)
    for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
      const preventDefault = vi.fn()
      contents.emit(event, { preventDefault })
      expect(preventDefault).toHaveBeenCalledOnce()
    }
    expect(contents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' })
    expect(contents.stop).toHaveBeenCalledOnce()
    expect(contents.close).toHaveBeenCalledOnce()
    window.emit('closed')
    const closed = vi.fn()
    popup.onClosed(closed)
    expect(closed).toHaveBeenCalledOnce()
  })

  it('protects the title and updates only main-frame origins, including redirects', () => {
    const { browserWindow, contents, window } = nativeWindow()
    prepareNativeBrowserPopup(browserWindow, () => true)
    const preventDefault = vi.fn()
    window.emit('page-title-updated', { preventDefault }, 'Spoofed title')
    expect(preventDefault).toHaveBeenCalledOnce()
    contents.emit('did-start-navigation', {}, 'https://iframe.example.net/secret', false, false)
    expect(window.setTitle).toHaveBeenCalledTimes(1)
    contents.emit(
      'will-redirect',
      {},
      'https://destination.example.net/callback?token=synthetic',
      false,
      true
    )
    expect(window.setTitle).toHaveBeenCalledTimes(1)
    contents.mainFrame.url = 'https://destination.example.net/other'
    contents.mainFrame.origin = 'https://destination.example.net'
    contents.emit('did-navigate', {}, 'https://uncommitted.example.org/')
    expect(window.setTitle).toHaveBeenLastCalledWith('https://destination.example.net')
  })
  it.each([
    ['', 'null', 'about:blank'],
    ['about:blank', 'https://inherited.example', 'about:blank'],
    ['https://trusted.example/callback?secret=synthetic', 'null', 'unknown'],
    ['data:text/html,synthetic', 'null', 'data:'],
    ['chrome-error://chromewebdata/', 'null', 'chrome-error:'],
    [
      'https://committed.example/callback?secret=synthetic',
      'https://committed.example',
      'https://committed.example'
    ]
  ])(
    'titles committed documents neutrally and ignores failed destinations: %s',
    (url, origin, label) => {
      const { browserWindow, contents, window } = nativeWindow()
      contents.mainFrame.url = url
      contents.mainFrame.origin = origin
      prepareNativeBrowserPopup(browserWindow, () => true)
      expect(window.setTitle).toHaveBeenLastCalledWith(label)
      contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://failed.example/secret', true)
      expect(window.setTitle).toHaveBeenLastCalledWith(label)
      contents.emit('did-navigate-in-page', {}, 'https://iframe.example', false)
      expect(window.setTitle).toHaveBeenCalledTimes(2)
    }
  )
})
