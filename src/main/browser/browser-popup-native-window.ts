import { app, webContents, type BrowserWindow, type WebContents } from 'electron'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import { describeCommittedPopupOrigin } from './popup-committed-origin'
import type { PopupChildWindowOptions, PopupOriginBarWindow } from './popup-origin-bar-window'
import {
  isNativeBrowserPopupWindow,
  markNativeBrowserPopupWindow
} from './native-browser-popup-windows'
import { MIN_POPUP_CONTENT_HEIGHT, MIN_POPUP_CONTENT_WIDTH } from './popup-window-minimum-size'

const rejectedNativePopups = new WeakSet<BrowserWindow>()
const discardedPopupContents = new WeakSet<WebContents>()
const nativePopupRequest = Symbol('native-popup-request')
type NativePopupAdmission = {
  document: Electron.WebFrameMain
  child?: WebContents
  canceled: boolean
  releaseNavigation?: () => void
  created: (window: BrowserWindow) => void
  stop: () => void
}
type NativePopupAdmissions = { pending?: NativePopupAdmission }
type NativePopupWindowOptions = Electron.BrowserWindowConstructorOptions & {
  [nativePopupRequest]?: NativePopupAdmission
}
const nativePopupAdmissions = new WeakMap<WebContents, NativePopupAdmissions>()
const scriptedChildAdmissions = new WeakMap<WebContents, NativePopupAdmission>()

function bindScriptedChild(_event: Electron.Event, child: WebContents): void {
  const frame = child.opener
  const source = frame && webContents.fromFrame(frame)
  const pending = source && nativePopupAdmissions.get(source)?.pending
  if (!pending || pending.child) {
    return
  }
  if (frame.top !== pending.document) {
    discardBrowserPopupContents(child)
    return
  }
  // Bind before Electron's later, mutable options/callback delivery can be overwritten.
  pending.child = child
  scriptedChildAdmissions.set(child, pending)
  child.once('destroyed', pending.stop)
  if (pending.canceled) {
    discardBrowserPopupContents(child)
    return
  }
  const blockNavigation = (event: Electron.Event): void => {
    pending.canceled = true
    event.preventDefault()
  }
  child.on('will-navigate', blockNavigation)
  child.on('will-frame-navigate', blockNavigation)
  child.on('will-redirect', blockNavigation)
  pending.releaseNavigation = () => {
    child.off('will-navigate', blockNavigation)
    child.off('will-frame-navigate', blockNavigation)
    child.off('will-redirect', blockNavigation)
  }
}

function prepareCreatedWindow(_event: Electron.Event, window: BrowserWindow): void {
  scriptedChildAdmissions.get(window.webContents)?.created(window)
}

function observeNativePopupAdmissions(opener: WebContents): NativePopupAdmissions {
  if (!app.listeners('web-contents-created').includes(bindScriptedChild)) {
    app.prependListener('web-contents-created', bindScriptedChild)
  }
  if (!app.listeners('browser-window-created').includes(prepareCreatedWindow)) {
    app.prependListener('browser-window-created', prepareCreatedWindow)
  }
  const state = nativePopupAdmissions.get(opener)
  if (state) {
    return state
  }
  const admissions: NativePopupAdmissions = {}
  nativePopupAdmissions.set(opener, admissions)
  const onCreated = (
    window: BrowserWindow,
    details?: { options: NativePopupWindowOptions }
  ): void => {
    if (isNativeBrowserPopupWindow(window)) {
      return
    }
    const bound = scriptedChildAdmissions.get(window.webContents)
    if (bound) {
      bound.created(window)
      return
    }
    const pending = admissions.pending
    // Only OpenURL owns its stack-local options; script options are an opener-wide mutable slot.
    if (
      !window.webContents.opener &&
      !discardedPopupContents.has(window.webContents) &&
      pending &&
      !pending.child &&
      details?.options[nativePopupRequest] === pending
    ) {
      pending.created(window)
      return
    }
    markNativeBrowserPopupWindow(window)
    rejectNativeBrowserPopup(window)
  }
  opener.prependListener('did-create-window', onCreated)
  opener.once('destroyed', () => {
    opener.off('did-create-window', onCreated)
    const pending = admissions.pending
    if (pending?.child) {
      discardBrowserPopupContents(pending.child)
    }
    pending?.stop()
    nativePopupAdmissions.delete(opener)
  })
  return admissions
}

/** Every popup handler must fence overlap, including requests taking another creation path. */
export function rejectOverlappingNativeBrowserPopup(opener: WebContents): boolean {
  const pending = nativePopupAdmissions.get(opener)?.pending
  if (!pending) {
    return false
  }
  pending.canceled = true
  if (pending.child) {
    discardBrowserPopupContents(pending.child)
  } else if (pending.document.isDestroyed()) {
    // A late child of the retired frame cannot identify itself as the new document's child.
    pending.stop()
    return false
  }
  return true
}

/** Chromium's OpenURL path has no adoptable contents or public navigation callback. */
export function isNativeBrowserPopupRequest(input: {
  disposition?: string
  features?: string
  frameName?: string
}): boolean {
  return (
    (input.disposition === 'new-window' || input.disposition === 'background-tab') &&
    input.features === '' &&
    input.frameName === ''
  )
}

/**
 * OpenURL reports its window after starting native navigation but before the first request.
 * Scripts bind at contents creation, independently of the later window/options delivery.
 */
export function allowNativeBrowserPopup(input: {
  opener: WebContents
  options: Electron.BrowserWindowConstructorOptions
  background?: boolean
  canPresent?: () => boolean
  onCreated: (options: PopupChildWindowOptions) => WebContents
}): Electron.WindowOpenHandlerResponse {
  const state = observeNativePopupAdmissions(input.opener)
  if (rejectOverlappingNativeBrowserPopup(input.opener) || input.opener.isDestroyed()) {
    return { action: 'deny' }
  }
  const mayPresent = !isBackgroundLaunch() && input.options.show !== false
  const stop = (): void => {
    admission.child?.off('destroyed', stop)
    admission.releaseNavigation?.()
    if (state.pending === admission) {
      state.pending = undefined
    }
  }
  const admission: NativePopupAdmission = {
    document: input.opener.mainFrame,
    canceled: false,
    created: (window) => {
      if (isNativeBrowserPopupWindow(window)) {
        return
      }
      markNativeBrowserPopupWindow(window)
      if (admission.canceled || state.pending !== admission) {
        stop()
        rejectNativeBrowserPopup(window)
        return
      }
      stop()
      try {
        if (input.opener.isDestroyed() || window.webContents.session !== input.opener.session) {
          rejectNativeBrowserPopup(window)
          return
        }
        input.onCreated({ ...input.options, nativeWindow: window })
        if (mayPresent && !rejectedNativePopups.has(window)) {
          window.once('ready-to-show', () => {
            try {
              if (
                input.options.show === false ||
                isBackgroundLaunch() ||
                rejectedNativePopups.has(window) ||
                window.isDestroyed() ||
                window.webContents.isDestroyed() ||
                input.opener.isDestroyed() ||
                window.webContents.session !== input.opener.session ||
                (input.canPresent && !input.canPresent())
              ) {
                return
              }
              if (input.background) {
                window.showInactive()
              } else {
                window.show()
              }
            } catch {}
          })
        }
      } catch {
        rejectNativeBrowserPopup(window)
      }
    },
    stop
  }
  state.pending = admission
  const options: NativePopupWindowOptions = {
    ...input.options,
    [nativePopupRequest]: admission,
    title: 'about:blank',
    fullscreenable: false,
    show: false,
    // Content-sized like origin-bar popups, so resizeTo cannot hide the origin title.
    useContentSize: true,
    minWidth: MIN_POPUP_CONTENT_WIDTH,
    minHeight: MIN_POPUP_CONTENT_HEIGHT,
    webPreferences: {
      ...input.options.webPreferences,
      session: input.opener.session
    }
  }
  return { action: 'allow', overrideBrowserWindowOptions: options }
}

/** Ends popup contents Chromium created before their pending first request can leave. */
export function discardBrowserPopupContents(contents: WebContents): void {
  if (contents.isDestroyed() || discardedPopupContents.has(contents)) {
    return
  }
  discardedPopupContents.add(contents)
  const denyNavigation = (event: Electron.Event): void => event.preventDefault()
  contents.on('will-navigate', denyNavigation)
  contents.on('will-frame-navigate', denyNavigation)
  contents.on('will-redirect', denyNavigation)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // close() is asynchronous during construction; stop the already scheduled navigation too.
  try {
    contents.stop()
  } catch {}
  try {
    contents.close()
  } catch {}
}

function rejectNativeBrowserPopup(window: BrowserWindow): void {
  rejectedNativePopups.add(window)
  discardBrowserPopupContents(window.webContents)
  // Destroy only after Electron's constructor returns, even if close failed or was intercepted.
  queueMicrotask(() => {
    if (!window.isDestroyed()) {
      window.destroy()
    }
  })
}

/** The native frame is the trust surface; public APIs cannot reparent its primary contents. */
export function prepareNativeBrowserPopup(
  window: BrowserWindow,
  prepareContent?: (contents: WebContents) => boolean
): PopupOriginBarWindow {
  const contents = window.webContents
  const closedListeners: (() => void)[] = []
  let closed = false
  window.once('closed', () => {
    closed = true
    for (const listener of closedListeners.splice(0)) {
      listener()
    }
  })
  const popup = {
    contentWebContents: contents,
    close: (): void => {
      if (!contents.isDestroyed()) {
        contents.close()
      }
    },
    onClosed: (listener: () => void): void => {
      if (closed) {
        listener()
      } else {
        closedListeners.push(listener)
      }
    }
  }
  let prepared = false
  try {
    prepared = prepareContent?.(contents) ?? true
  } catch {}
  if (!prepared) {
    rejectNativeBrowserPopup(window)
    return popup
  }
  const updateOrigin = (): void => {
    if (!window.isDestroyed()) {
      window.setTitle(describeCommittedPopupOrigin(contents).label)
    }
  }
  window.on('page-title-updated', (event) => event.preventDefault())
  contents.on('did-navigate', updateOrigin)
  contents.on('did-fail-load', updateOrigin)
  contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame) {
      updateOrigin()
    }
  })
  updateOrigin()
  return popup
}
