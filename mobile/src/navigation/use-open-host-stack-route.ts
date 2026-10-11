import { useCallback, useEffect, useRef } from 'react'
import { useNavigation, useRouter } from 'expo-router'
import {
  coordinateHostStackNavigation,
  type HostStackLanding,
  type HostStackRootNavigation,
  type HostStackRouteTarget,
  type PendingHostStackNavigation
} from './host-stack-navigation'

// Why: one root navigator means one pending transition. A per-hook ref would let a
// Resume tap and a Tasks tap arm two independent pushes that cannot cancel each other.
let pendingNavigation: PendingHostStackNavigation | null = null

export function useOpenHostStackRoute(): (
  hostId: string,
  target: HostStackRouteTarget,
  landing?: HostStackLanding
) => void {
  const navigation = useNavigation<HostStackRootNavigation>()
  const router = useRouter()
  // Why: an unmounting screen may only cancel a transition it armed itself — home
  // unmounting for onboarding must not kill a notification push still in flight.
  const armedRef = useRef<PendingHostStackNavigation | null>(null)

  useEffect(
    () => () => {
      if (armedRef.current && armedRef.current === pendingNavigation) {
        pendingNavigation.controller.cancel()
        pendingNavigation = null
      }
      armedRef.current = null
    },
    []
  )

  return useCallback(
    (hostId, target, landing) => {
      pendingNavigation = coordinateHostStackNavigation(
        pendingNavigation,
        navigation,
        router,
        hostId,
        target,
        landing
      )
      armedRef.current = pendingNavigation
    },
    [navigation, router]
  )
}
