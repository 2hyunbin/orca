import { useEffect, useState } from 'react'
import { Text } from 'react-native'
import { hostScreenStyles } from '../host-screen/host-screen-styles'
import { loadHosts } from '../transport/host-store'
import type { HostProfile } from '../transport/types'
import { useHostDisplay } from '../transport/use-host-display'

/** The desktop these tasks belong to, in the host screen's subtitle line. */
export function MobileTasksHostSubtitle({ hostId }: { hostId: string }) {
  const [host, setHost] = useState<HostProfile | null>(null)
  useEffect(() => {
    let stale = false
    setHost(null)
    void loadHosts().then((hosts) => {
      if (!stale) {
        setHost(hosts.find((profile) => profile.id === hostId) ?? null)
      }
    })
    return () => {
      stale = true
    }
  }, [hostId])
  const title = useHostDisplay(host).title
  // Null until the profile is read: an unknown host would otherwise show the generic "Host".
  return host ? (
    <Text style={hostScreenStyles.hostPlatformText} numberOfLines={1}>
      {title}
    </Text>
  ) : null
}
