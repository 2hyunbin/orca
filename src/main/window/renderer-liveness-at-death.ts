import type { BrowserWindow } from 'electron'
import { recordCoalescedDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'

/**
 * What the main window looked like to the user when its renderer died.
 *
 * Why: Windows `killed`/exit 1 reports are identical whether Task Manager, an EDR or
 * Orca held the knife. A renderer that had been hung for minutes, or a document
 * that never loaded (the post-update blank frame), turns "outside kill" into "the
 * user ended a frozen Orca" — and that is an Orca bug to chase, not noise.
 */
export type RendererLivenessAtDeath = {
  /** Set only while Chromium considers the renderer hung; absent means responsive. */
  rendererUnresponsiveForMs?: number
  /** False when the current document never reached did-finish-load (blank window). */
  rendererDocumentLoaded: boolean
  /** Age of the current document, so "never loaded" reads as seconds or minutes. */
  rendererDocumentAgeMs: number
  /** Absent when the window was already destroyed. */
  mainWindowState?: 'visible' | 'minimized' | 'hidden'
  mainWindowFocused?: boolean
}

// Why no dispose: every listener lives on the window or its webContents and dies with them.
export type RendererLivenessTracker = {
  read: () => RendererLivenessAtDeath
}

// Why coalesced: a renderer that flaps hung/responsive must not evict the 30-slot ring.
const UNRESPONSIVE_CRUMB_MIN_INTERVAL_MS = 60_000

export function trackRendererLivenessAtDeath(
  window: BrowserWindow,
  now: () => number = Date.now
): RendererLivenessTracker {
  const contents = window.webContents
  let unresponsiveSince: number | null = null
  let documentLoaded = false
  let documentStartedAt = now()

  const onUnresponsive = (): void => {
    unresponsiveSince ??= now()
    recordCoalescedDurableCrashBreadcrumb({
      name: 'renderer_unresponsive',
      coalesceKey: 'main-window-renderer-unresponsive',
      minIntervalMs: UNRESPONSIVE_CRUMB_MIN_INTERVAL_MS
    })
  }
  const onResponsive = (): void => {
    if (unresponsiveSince === null) {
      return
    }
    const hungForMs = now() - unresponsiveSince
    unresponsiveSince = null
    recordCoalescedDurableCrashBreadcrumb({
      name: 'renderer_responsive',
      data: { hungForMs },
      coalesceKey: 'main-window-renderer-responsive',
      minIntervalMs: UNRESPONSIVE_CRUMB_MIN_INTERVAL_MS
    })
  }
  // Why reset the hang here: a recovery reload is a fresh renderer, and a stale
  // timestamp would make its first report claim a hang it never had.
  const onNavigate = (): void => {
    unresponsiveSince = null
    documentLoaded = false
    documentStartedAt = now()
  }
  const onLoaded = (): void => {
    documentLoaded = true
  }
  window.on('unresponsive', onUnresponsive)
  window.on('responsive', onResponsive)
  contents.on('did-navigate', onNavigate)
  contents.on('did-finish-load', onLoaded)

  return {
    read: () => {
      const at = now()
      return {
        ...(unresponsiveSince === null
          ? {}
          : { rendererUnresponsiveForMs: at - unresponsiveSince }),
        rendererDocumentLoaded: documentLoaded,
        rendererDocumentAgeMs: at - documentStartedAt,
        ...readWindowState(window)
      }
    }
  }
}

function readWindowState(
  window: BrowserWindow
): Pick<RendererLivenessAtDeath, 'mainWindowState' | 'mainWindowFocused'> {
  // Why never throw: this runs inside render-process-gone ahead of recovery
  // scheduling, and a window dying mid-close throws on every getter.
  try {
    if (window.isDestroyed()) {
      return {}
    }
    return {
      mainWindowState: window.isMinimized()
        ? 'minimized'
        : window.isVisible()
          ? 'visible'
          : 'hidden',
      mainWindowFocused: window.isFocused()
    }
  } catch {
    return {}
  }
}
