import { useEffect } from 'react'
import { useRouteHandoff } from '../navigation/route-handoff'

/** A host the gate blocks, on an overlay route: the host list explains it full screen. */
export function OverlayGateBlocked({ hostId }: { hostId: string }) {
  const router = useRouteHandoff()
  useEffect(() => {
    router.replace(`/h/${encodeURIComponent(hostId)}`)
  }, [hostId, router])
  return null
}
