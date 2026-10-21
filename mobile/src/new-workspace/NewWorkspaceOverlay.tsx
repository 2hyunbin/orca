import { HostProtocolGate } from '../components/HostProtocolGate'
import { OverlayScrim } from '../components/overlay-scrim'
import { MobileWebShellScreen } from '../mobile-web-shell/MobileWebShellScreen'
import { shellScreenRoute } from '../mobile-web-shell/shell-screen-route'
import { OverlayGateBlocked } from './overlay-gate-views'

/**
 * The picked desktop's Create Workspace page in the shell, as an overlay: the page draws the drawer
 * over a transparent document, and the shell dims the screen beneath until it has.
 */
export function NewWorkspaceOverlay({ hostId }: { hostId: string }) {
  const route = shellScreenRoute({ pathname: `/h/${encodeURIComponent(hostId)}/new-workspace` })
  if (route === null) {
    return <OverlayGateBlocked hostId={hostId} />
  }
  return (
    // The gate every `/h` route gets from its layout, which this one sits outside of to overlay Home.
    <HostProtocolGate
      hostId={hostId}
      pending={<OverlayScrim />}
      blocked={<OverlayGateBlocked hostId={hostId} />}
    >
      <MobileWebShellScreen key={hostId} hostId={hostId} route={route} presentation="overlay" />
    </HostProtocolGate>
  )
}
