import { useEffect } from 'react'
import { WorkspaceDetailPlaceholder } from '../../../src/components/WorkspaceDetailPlaceholder'
import { HostScreen } from '../../../src/host-screen/HostScreen'
import { usePageOwnsHostArea } from '../../../src/mobile-web-shell/page-owns-host-area'
import { usePageBridgeClientIfPresent } from '../../../src/transport/client-context.web'

/**
 * The page's route for the worktree list: the screen itself. The native route file mounts the shell, whose
 * native view module throws at import in a browser, and the manifest imports every route.
 */
export default function HostWorktreeRoute() {
  useSpendOpenedRouteAction()
  // The placeholder only beside the page's own sidebar: without the host area this is the list.
  return usePageOwnsHostArea() ? <WorkspaceDetailPlaceholder /> : <HostScreen />
}

/**
 * Erases the `action` the shell opened this page with (ruling 34). The list already read it from the
 * history the first `init` wrote; only the shell can stop a reload's `init` replaying it. Only a
 * shell that put `action` on the route hears this, so an older shell never receives the frame.
 */
function useSpendOpenedRouteAction(): void {
  const client = usePageBridgeClientIfPresent()
  useEffect(() => {
    const action = client?.getShellSession()?.route?.params?.action
    if (client && action) {
      client.clearRouteParam('action', action)
    }
  }, [client])
}
