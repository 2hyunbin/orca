import { useEffect } from 'react'
import { useRouteHandoff } from '../navigation/route-handoff'

/**
 * An overlay whose page cannot show (a blocked or older desktop, a failed load): the host list,
 * full screen, says why in its place.
 */
export function OpenHostListInstead({ hostId }: { hostId: string }) {
  const router = useRouteHandoff()
  useEffect(() => {
    router.replace(`/h/${encodeURIComponent(hostId)}`)
  }, [hostId, router])
  return null
}
