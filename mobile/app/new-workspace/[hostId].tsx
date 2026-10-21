import { useLocalSearchParams } from 'expo-router'
import { HostProtocolGate } from '../../src/components/HostProtocolGate'
import { MobileWebShellScreen } from '../../src/mobile-web-shell/MobileWebShellScreen'
import { shellScreenRoute } from '../../src/mobile-web-shell/shell-screen-route'
import { PageRouteUnavailableScreen } from '../../src/mobile-web-shell/PageRouteUnavailableScreen'
import { firstParam } from '../../src/navigation/route-param-reader'
import { OverlayGateBlocked, OverlayGatePending } from '../../src/new-workspace/overlay-gate-views'

/**
 * Home's New Workspace drawer: a transparent modal over Home whose content is the page's
 * `/h/<host>/new-workspace` route, which draws the host screen's own Create Workspace sheet.
 */
export default function NewWorkspaceDrawerRoute() {
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  const hostId = firstParam(params.hostId)
  const route = hostId
    ? shellScreenRoute({ pathname: `/h/${encodeURIComponent(hostId)}/new-workspace` })
    : null
  if (route === null) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  // The gate every `/h` route gets from its layout; this route sits outside `/h` to present over Home.
  return (
    <HostProtocolGate
      hostId={hostId}
      pending={<OverlayGatePending animateIn />}
      blocked={<OverlayGateBlocked hostId={hostId} />}
    >
      <MobileWebShellScreen key={hostId} hostId={hostId} route={route} presentation="overlay" />
    </HostProtocolGate>
  )
}
