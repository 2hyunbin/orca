import { app, type BrowserWindow, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import type { PopupChildWindowOptions, PopupOriginBarWindow } from './popup-origin-bar-window'
import {
  isNativeBrowserPopupWindow,
  markNativeBrowserPopupWindow
} from './native-browser-popup-windows'
import { MIN_POPUP_CONTENT_HEIGHT, MIN_POPUP_CONTENT_WIDTH } from './popup-window-minimum-size'
import { describeCommittedPopupOrigin } from './popup-committed-origin'

const rejectedNativePopups = new WeakSet<BrowserWindow>()
const SCRIPTED_POPUP_ARGUMENT_PREFIX = '--orca-native-popup-admission='
const MAX_PENDING_SCRIPTED_POPUPS = 64
const SCRIPTED_POPUP_ADMISSION_TTL_MS = 30_000
type ScriptedPopupAdmission = {
  admit: (window: BrowserWindow) => void
  expiresAt: number
  timeout: ReturnType<typeof setTimeout>
}
const pendingScriptedNativePopups = new WeakMap<WebContents, Map<string, ScriptedPopupAdmission>>()

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
 * OpenURL constructs this window synchronously, before resuming its native navigation; a script
 * window.open constructs it in a later task, when the renderer shows the child it created.
 */
export function allowNativeBrowserPopup(input: {
  opener: WebContents
  options: Electron.BrowserWindowConstructorOptions
  background?: boolean
  canPresent?: () => boolean
  onCreated: (options: PopupChildWindowOptions) => WebContents
}): Electron.WindowOpenHandlerResponse {
  const requestArgument = `${SCRIPTED_POPUP_ARGUMENT_PREFIX}${randomUUID()}`
  const mayPresent = !isBackgroundLaunch() && input.options.show !== false
  const admit = (window: BrowserWindow): void => {
    markNativeBrowserPopupWindow(window)
    try {
      if (input.opener.isDestroyed() || window.webContents.session !== input.opener.session) {
        rejectNativeBrowserPopup(window)
        return
      }
      input.onCreated({ ...input.options, nativeWindow: window })
      if (input.background && mayPresent && !rejectedNativePopups.has(window)) {
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
            window.showInactive()
          } catch {}
        })
      }
    } catch {
      rejectNativeBrowserPopup(window)
    }
  }
  let admitted = false
  const onCreated = (_event: Electron.Event, window: BrowserWindow): void => {
    admitted = true
    admit(window)
  }
  // Prepend prevents another browser-window-created listener from navigating the child first.
  app.prependOnceListener('browser-window-created', onCreated)
  // A canceled native creation must not grant the next unrelated window this admission.
  queueMicrotask(() => {
    app.off('browser-window-created', onCreated)
    if (!admitted) {
      awaitScriptedNativePopup(input.opener, requestArgument, admit)
    }
  })
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      ...input.options,
      title: 'about:blank',
      fullscreenable: false,
      show: mayPresent && !input.background,
      // Content-sized like origin-bar popups, so resizeTo cannot hide the origin title.
      useContentSize: true,
      minWidth: MIN_POPUP_CONTENT_WIDTH,
      minHeight: MIN_POPUP_CONTENT_HEIGHT,
      webPreferences: {
        ...input.options.webPreferences,
        session: input.opener.session,
        additionalArguments: [
          ...(input.options.webPreferences?.additionalArguments ?? []).filter(
            (argument) => !argument.startsWith(SCRIPTED_POPUP_ARGUMENT_PREFIX)
          ),
          requestArgument
        ]
      }
    }
  }
}

// Electron emits did-create-window on the opener synchronously after constructing the child, before
// the child's first request; unadmitted native children there are discarded rather than left bare.
function awaitScriptedNativePopup(
  opener: WebContents,
  requestArgument: string,
  admit: (window: BrowserWindow) => void
): void {
  if (opener.isDestroyed()) {
    return
  }
  if (!pendingScriptedNativePopups.has(opener)) {
    const admissions = new Map<string, ScriptedPopupAdmission>()
    pendingScriptedNativePopups.set(opener, admissions)
    const onCreated = (window: BrowserWindow, details: Electron.DidCreateWindowDetails): void => {
      if (isNativeBrowserPopupWindow(window)) {
        return
      }
      // Electron carries these main-process options across delayed and reordered child delivery.
      const markers = details?.options?.webPreferences?.additionalArguments?.filter((argument) =>
        argument.startsWith(SCRIPTED_POPUP_ARGUMENT_PREFIX)
      )
      const marker = markers?.length === 1 ? markers[0] : undefined
      const pending = marker ? admissions.get(marker) : undefined
      if (marker && pending) {
        admissions.delete(marker)
        clearTimeout(pending.timeout)
      }
      if (pending && pending.expiresAt > Date.now()) {
        pending.admit(window)
      } else {
        markNativeBrowserPopupWindow(window)
        rejectNativeBrowserPopup(window)
      }
    }
    opener.prependListener('did-create-window', onCreated)
    opener.on('destroyed', () => {
      opener.off('did-create-window', onCreated)
      for (const pending of admissions.values()) {
        clearTimeout(pending.timeout)
      }
      admissions.clear()
      pendingScriptedNativePopups.delete(opener)
    })
  }
  const admissions = pendingScriptedNativePopups.get(opener)
  if (!admissions) {
    return
  }
  const timeout = setTimeout(
    () => admissions.delete(requestArgument),
    SCRIPTED_POPUP_ADMISSION_TTL_MS
  )
  timeout.unref()
  admissions.set(requestArgument, {
    admit,
    expiresAt: Date.now() + SCRIPTED_POPUP_ADMISSION_TTL_MS,
    timeout
  })
  if (admissions.size > MAX_PENDING_SCRIPTED_POPUPS) {
    const oldest = admissions.entries().next().value
    if (oldest) {
      clearTimeout(oldest[1].timeout)
      admissions.delete(oldest[0])
    }
  }
}

/** Ends popup contents Chromium created before their pending first request can leave. */
export function discardBrowserPopupContents(contents: WebContents): void {
  if (contents.isDestroyed()) {
    return
  }
  const denyNavigation = (event: Electron.Event): void => event.preventDefault()
  contents.on('will-navigate', denyNavigation)
  contents.on('will-frame-navigate', denyNavigation)
  contents.on('will-redirect', denyNavigation)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // close() is asynchronous during construction; the guards stop the pending request.
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
  const close = (): void => {
    if (!contents.isDestroyed()) {
      contents.close()
    }
  }
  const popup = {
    contentWebContents: contents,
    close,
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
  // A blocked/uncommitted redirect must never lend its origin to the old document.
  contents.on('did-navigate', updateOrigin)
  contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame) {
      updateOrigin()
    }
  })
  contents.on('did-fail-load', (_event, _errorCode, _errorDescription, _url, isMainFrame) => {
    if (isMainFrame) {
      updateOrigin()
    }
  })
  updateOrigin()
  return popup
}
