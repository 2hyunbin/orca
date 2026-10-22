import { useEffect, useState } from 'react'
import type { AgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import {
  readHostAgentLaunchSettings,
  subscribeHostAgentLaunchSettings
} from './agent-launch-settings-transport'

type Preferences = Pick<AgentLaunchSettings, 'defaultTuiAgent' | 'disabledTuiAgents'>
/** `desktop`: the host predates host launch settings, so this client's own choices still apply. */
type Snapshot = Preferences | 'desktop' | 'failed'
type Observation = { key: string; snapshot: Snapshot | null }

// Why: menus mount on open; the last answer per host lets them render at once while revalidating.
const snapshotByEnvironment = new Map<
  string,
  { key: string; snapshot: Exclude<Snapshot, 'failed'> }
>()
subscribeHostAgentLaunchSettings((owner) => {
  snapshotByEnvironment.delete(owner.environmentId)
})

export function clearHostAgentMenuSettingsForTests(): void {
  snapshotByEnvironment.clear()
}

function cachedSnapshot(environmentId: string | undefined, key: string): Snapshot | null {
  const cached = environmentId ? snapshotByEnvironment.get(environmentId) : undefined
  return cached?.key === key ? cached.snapshot : null
}

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
  const [observation, setObservation] = useState<Observation>(() => ({
    key,
    snapshot: cachedSnapshot(environmentId, key)
  }))
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
            const snapshot = settings
              ? {
                  defaultTuiAgent: settings.defaultTuiAgent,
                  disabledTuiAgents: settings.disabledTuiAgents
                }
              : 'desktop'
            snapshotByEnvironment.set(environmentId, { key, snapshot })
            setObservation({ key, snapshot })
          }
        },
        () => {
          if (live && !readController.signal.aborted) {
            // A transient failure keeps this runtime's last answer.
            setObservation({ key, snapshot: cachedSnapshot(environmentId, key) ?? 'failed' })
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
  const snapshot =
    (observation.key === key ? observation.snapshot : null) ?? cachedSnapshot(environmentId, key)
  if (snapshot === 'desktop') {
    return { settings: desktopSettings, pending: false }
  }
  // Why: a first-read failure must not borrow this client's preferences for another machine.
  const preferences = snapshot === null || snapshot === 'failed' ? null : snapshot
  return {
    pending: snapshot === null,
    settings: {
      ...desktopSettings,
      defaultTuiAgent: preferences?.defaultTuiAgent ?? null,
      disabledTuiAgents: preferences?.disabledTuiAgents ?? []
    }
  }
}
