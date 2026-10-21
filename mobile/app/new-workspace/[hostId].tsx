import { useLocalSearchParams } from 'expo-router'
import { HostProtocolGate } from '../../src/components/HostProtocolGate'
import { MobileWebShellScreen } from '../../src/mobile-web-shell/MobileWebShellScreen'
import { shellScreenRoute } from '../../src/mobile-web-shell/shell-screen-route'
import { PageRouteUnavailableScreen } from '../../src/mobile-web-shell/PageRouteUnavailableScreen'
import { firstParam } from '../../src/navigation/route-param-reader'

/**
 * Home's New Workspace drawer: a native form sheet over Home whose content is the page's
 * `/h/<host>/new-workspace` route. The loading, download and failure states render in the drawer.
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
    <HostProtocolGate hostId={hostId}>
      <MobileWebShellScreen key={hostId} hostId={hostId} route={route} presentation="sheet" />
    </HostProtocolGate>
  )
}
