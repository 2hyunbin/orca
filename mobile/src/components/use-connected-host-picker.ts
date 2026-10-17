import { useRef, useState } from 'react'
import { hostEndpointLabel } from '../transport/host-endpoint-label'
import type { HostProfile } from '../transport/types'

function hostPickerOptions(hosts: HostProfile[]) {
  const entries = hosts.map((host) => ({
    host,
    endpointLabel: hostEndpointLabel(host.endpoint)
  }))
  const endpointCounts = new Map<string, number>()
  for (const entry of entries) {
    const endpointKey = JSON.stringify([entry.host.name, entry.endpointLabel])
    endpointCounts.set(endpointKey, (endpointCounts.get(endpointKey) ?? 0) + 1)
  }
  return entries.map((entry) => {
    const endpointKey = JSON.stringify([entry.host.name, entry.endpointLabel])
    const endpointCollides = (endpointCounts.get(endpointKey) ?? 0) > 1
    const subtitle = endpointCollides
      ? `${entry.endpointLabel} · ${entry.host.id}`
      : entry.endpointLabel
    return { value: entry.host.id, label: entry.host.name, subtitle }
  })
}

/** Runs an action on the only connected host, or on the one picked when several are connected. */
export function useConnectedHostPicker(connectedHosts: HostProfile[]) {
  const [pickerForHostSet, setPickerForHostSet] = useState<string | null>(null)
  const pendingActionRef = useRef<((hostId: string) => void) | null>(null)
  const pendingHostIdRef = useRef<string | null>(null)
  const hostSetKey = JSON.stringify(connectedHosts.map((host) => host.id))
  const visible = pickerForHostSet === hostSetKey
  if (pickerForHostSet !== null && !visible) {
    setPickerForHostSet(null)
  }

  function pickHost(action: (hostId: string) => void) {
    if (connectedHosts.length === 1) {
      action(connectedHosts[0].id)
      return
    }
    if (connectedHosts.length > 1) {
      pendingActionRef.current = action
      setPickerForHostSet(hostSetKey)
    }
  }

  function onSelect(hostId: string) {
    pendingHostIdRef.current = hostId
    setPickerForHostSet(null)
  }

  function onAfterClose() {
    setPickerForHostSet(null)
    const hostId = pendingHostIdRef.current
    const action = pendingActionRef.current
    pendingHostIdRef.current = null
    pendingActionRef.current = null
    if (hostId && action && connectedHosts.some((host) => host.id === hostId)) {
      action(hostId)
    }
  }

  return {
    pickHost,
    pickerProps: {
      visible,
      options: hostPickerOptions(connectedHosts),
      selected: '',
      onSelect,
      onClose: () => setPickerForHostSet(null),
      onAfterClose
    }
  }
}
