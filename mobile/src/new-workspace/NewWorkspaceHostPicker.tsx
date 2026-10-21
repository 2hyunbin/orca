import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { OverlayScrim } from '../components/overlay-scrim'
import { PickerModal } from '../components/PickerModal'
import { useConnectedHostPicker } from '../components/use-connected-host-picker'
import { selectConnectableHostProfiles } from '../transport/host-catalog-selection'
import { loadHostCatalog } from '../transport/host-store'
import type { HostProfile } from '../transport/types'

/**
 * Home's "Create Workspace On" picker, inside the overlay so the drawer that follows opens from the
 * same window: once a desktop is picked the screen stays dimmed while the picker slides away.
 */
export function NewWorkspaceHostPicker({
  hostIds,
  onPick
}: {
  hostIds: readonly string[]
  onPick: (hostId: string) => void
}) {
  const router = useRouter()
  const hosts = useOfferedHosts(hostIds)
  const { pickHost, pickerProps } = useConnectedHostPicker(hosts ?? [])
  const [picked, setPicked] = useState(false)
  const offeredRef = useRef(false)

  useEffect(() => {
    if (hosts === null || offeredRef.current) {
      return
    }
    offeredRef.current = true
    if (hosts.length === 0) {
      router.back()
      return
    }
    pickHost(onPick)
  }, [hosts, onPick, pickHost, router])

  return (
    <>
      {picked ? <OverlayScrim /> : null}
      <PickerModal
        title="Create Workspace On"
        {...pickerProps}
        onSelect={(hostId) => {
          setPicked(true)
          pickerProps.onSelect(hostId)
        }}
        onAfterClose={() => {
          pickerProps.onAfterClose()
          if (!picked) {
            router.back()
          }
        }}
      />
    </>
  )
}

/** The offered desktops' profiles, in the offered order; `null` until the catalog is read. */
function useOfferedHosts(hostIds: readonly string[]): HostProfile[] | null {
  const [hosts, setHosts] = useState<HostProfile[] | null>(null)
  const key = hostIds.join(',')
  useEffect(() => {
    let live = true
    void loadHostCatalog().then((catalog) => {
      const profiles = new Map(
        selectConnectableHostProfiles(catalog).map((host) => [host.id, host] as const)
      )
      if (live) {
        setHosts(key.split(',').flatMap((hostId) => profiles.get(hostId) ?? []))
      }
    })
    return () => {
      live = false
    }
  }, [key])
  return hosts
}
