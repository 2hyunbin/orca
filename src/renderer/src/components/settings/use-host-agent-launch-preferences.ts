import { useEffect, useState } from 'react'
import type { AgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import {
  readHostAgentLaunchSettings,
  subscribeHostAgentLaunchSettings
} from './agent-launch-settings-transport'

type Preferences = Pick<AgentLaunchSettings, 'defaultTuiAgent' | 'disabledTuiAgents'>
type Observation =
  | { key: string; state: 'pending' }
  | { key: string; state: 'settled'; preferences: Preferences | null }

export function useHostAgentMenuSettings(
  owner: {
    executionHostId: string
    pairingRevision: number | undefined
    runtimeId: string | null | undefined
    contact: string
  } | null,
  desktopSettings: GlobalSettings | null,
  active: boolean,
  open: boolean
) {
  const host = parseExecutionHostId(owner?.executionHostId)
  const environmentId = host?.kind === 'runtime' ? host.environmentId : undefined
  const { pairingRevision, runtimeId, contact } = owner ?? {}
  const key = JSON.stringify([environmentId, pairingRevision, runtimeId])
  const [observation, setObservation] = useState<Observation>({ key, state: 'pending' })
  useEffect(() => {
    if (!environmentId || !active) {
      return
    }
    const capturedOwner = { environmentId, pairingRevision, runtimeId: runtimeId ?? undefined }
    let controller = new AbortController()
    let live = true
    const refresh = (): void => {
      controller.abort()
      const readController = new AbortController()
      controller = readController
      void readHostAgentLaunchSettings(capturedOwner, readController.signal).then(
        (settings) => {
          if (live && !readController.signal.aborted) {
            setObservation({ key, state: 'settled', preferences: settings })
          }
        },
        () => {
          if (live && !readController.signal.aborted) {
            setObservation((previous) =>
              previous.key === key && previous.state === 'settled'
                ? previous
                : { key, state: 'settled', preferences: null }
            )
          }
        }
      )
    }
    const unsubscribe = subscribeHostAgentLaunchSettings((changedOwner) => {
      if (
        changedOwner.environmentId === environmentId &&
        changedOwner.pairingRevision === pairingRevision
      ) {
        refresh()
      }
    })
    refresh()
    return () => {
      live = false
      controller.abort()
      unsubscribe()
    }
  }, [environmentId, pairingRevision, runtimeId, key, contact, active, open])
  if (!environmentId) {
    return { settings: desktopSettings, pending: false }
  }
  const current = observation.key === key ? observation : null
  const preferences = current?.state === 'settled' ? current.preferences : null
  return {
    pending: current?.state !== 'settled',
    settings: {
      ...desktopSettings,
      defaultTuiAgent: preferences?.defaultTuiAgent ?? null,
      disabledTuiAgents: preferences?.disabledTuiAgents ?? []
    }
  }
}
