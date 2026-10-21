import { useEffect, type ReactNode } from 'react'
import { useRouter } from 'expo-router'
import { OverlayScrim } from '../components/overlay-scrim'
import type { HostDisplaySource } from '../transport/use-host-display'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import { ShellDownloadProgress } from './ShellDownloadProgress'

/** What an overlay cannot show in place of its page's drawer: the host list says it full screen. */
function overlayHandsToHostList(kind: MobileWebShellSessionState['kind']): boolean {
  return kind === 'route-unavailable' || kind === 'wall' || kind === 'failed' || kind === 'offline'
}

/**
 * The shell as a transparent overlay whose page draws a drawer: until that page has painted, the
 * screen beneath is only dimmed (with the download bar while downloading, else a spinner), and a
 * host that cannot serve the page — an older desktop, a wall, a failure — opens the host list.
 *
 * `screen` replaces the shell's state screens and `cover` its page cover; both are `undefined`
 * when this is not an overlay, which leaves the shell exactly as it was.
 */
export function useShellOverlay(
  enabled: boolean,
  hostId: string,
  state: MobileWebShellSessionState,
  host: HostDisplaySource | null
): { screen: ReactNode | undefined; cover: (unpainted: boolean) => ReactNode | undefined } {
  const router = useRouter()
  const handsOff = enabled && overlayHandsToHostList(state.kind)
  useEffect(() => {
    if (handsOff) {
      router.replace(`/h/${encodeURIComponent(hostId)}`)
    }
  }, [handsOff, hostId, router])

  if (!enabled) {
    return { screen: undefined, cover: () => undefined }
  }
  let screen: ReactNode | undefined
  if (handsOff) {
    screen = null
  } else if (state.kind === 'fetching') {
    screen = (
      <OverlayScrim>
        <ShellDownloadProgress state={state} host={host} />
      </OverlayScrim>
    )
  } else if (state.kind !== 'ready') {
    screen = <OverlayScrim />
  }
  return { screen, cover: (unpainted) => (unpainted ? <OverlayScrim /> : null) }
}
