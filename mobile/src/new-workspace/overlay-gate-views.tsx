import { useEffect } from 'react'
import { ShellSheetPlaceholder } from '../mobile-web-shell/ShellSheetPlaceholder'
import { useRouteHandoff } from '../navigation/route-handoff'

const noop = () => {}

/** The gate's wait on an overlay route: the sheet placeholder already on screen, standing still. */
export function OverlayGatePending({ animateIn = false }: { animateIn?: boolean }) {
  return <ShellSheetPlaceholder animateIn={animateIn} onEntered={noop} onDismiss={noop} />
}

/** A blocked host on an overlay route: the host list, which explains it full screen. */
export function OverlayGateBlocked({ hostId }: { hostId: string }) {
  const router = useRouteHandoff()
  useEffect(() => {
    router.replace(`/h/${encodeURIComponent(hostId)}`)
  }, [hostId, router])
  return null
}
