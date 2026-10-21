import { useLayoutEffect } from 'react'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import type { ShellPageFrame } from './shell-page-frame'

export type ShellOverlayDownload = { receivedBytes: number; totalBytes: number }

/** How far an overlay shell's page is from drawing over the screen beneath. */
export type ShellOverlayLoad =
  | { kind: 'loading'; download: ShellOverlayDownload | null }
  | { kind: 'painted' }

/** What an overlay cannot show in place of its page's drawer: the host list says it full screen. */
export function shellOverlayExits(kind: MobileWebShellSessionState['kind']): boolean {
  return kind === 'route-unavailable' || kind === 'wall' || kind === 'failed' || kind === 'offline'
}

/**
 * Reports an overlay shell's load to the route that draws its loading state, which outlives the
 * shell's own state screens so one view covers every stage.
 */
export function useReportedShellOverlayLoad(
  onLoad: ((load: ShellOverlayLoad) => void) | undefined,
  state: MobileWebShellSessionState,
  pageFrame: ShellPageFrame
): void {
  const painted = pageFrame === 'painted'
  const receivedBytes = state.kind === 'fetching' ? state.receivedBytes : null
  const totalBytes = state.kind === 'fetching' ? state.totalBytes : 0
  // Before paint, so the caller's view swaps in the same frame the WebView is shown.
  useLayoutEffect(() => {
    if (onLoad === undefined) {
      return
    }
    onLoad(
      painted
        ? { kind: 'painted' }
        : {
            kind: 'loading',
            download: receivedBytes === null ? null : { receivedBytes, totalBytes }
          }
    )
  }, [onLoad, painted, receivedBytes, totalBytes])
}
