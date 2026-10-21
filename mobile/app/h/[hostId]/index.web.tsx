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

/** Spends the shell's `action` once read, so a reload's re-sent `init` cannot reopen the sheet (ruling 34). */
function useSpendOpenedRouteAction(): void {
  const client = usePageBridgeClientIfPresent()
  useEffect(() => {
    const action = client?.getShellSession()?.route?.params?.action
    if (client && action) {
      client.clearRouteParam('action', action)
    }
  }, [client])
}
