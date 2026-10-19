/** IPC for a host an older build changed after conversion: move its newer projects, or keep the server's. */
import { ipcMain } from 'electron'
import type {
  OrcadDeltaMovePreview,
  OrcadDeltaMoveResult
} from '../../../shared/orcad-managed-runtime'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import { requireManagedOrcadInfrastructure } from '../../managed-server/lifecycle/orcad-managed-runtime-context'
import { ensureOrcadManagedTunnel } from '../../managed-server/lifecycle/orcad-managed-tunnel'
import {
  keepOrcadServerVersion,
  previewOrcadDeltaMove,
  runOrcadDeltaMove
} from '../../ssh/orcad-migration-delta-move'
import { censusHostRelayTerminalsFor } from '../../ssh/legacy-relay/ssh-host-relay-census-for-target'
import { orcadMigrationDestinationFor } from '../../managed-server/lifecycle/orcad-runtime-conversion-wiring'
import { requiredString } from './orcad-runtime-lifecycle-handlers'
import { publishResolvedChangedHostStatus } from './runtime-environment-managed-tunnel'
import { runTargetLifecycle } from '../ssh/ssh-target-lifecycle-queue'

export function registerOrcadDeltaMoveHandlers(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:previewOrcadDeltaMove',
    async (_event, args: { sshTargetId: string }): Promise<OrcadDeltaMovePreview> => {
      const userDataPath = getUserDataPath()
      const { store, target, environmentId } = requireChangedHost(args)
      const environment = listEnvironments(userDataPath).find((entry) => entry.id === environmentId)
      if (!environment) {
        throw new Error('The managed Orca server for this host is no longer registered.')
      }
      return previewOrcadDeltaMove({
        userDataPath,
        store,
        target,
        destination: orcadMigrationDestinationFor(environment),
        ensureTunnel: async () => {
          await ensureOrcadManagedTunnel(userDataPath, environment.id)
        }
      })
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:moveOrcadDelta',
    async (_event, args: { sshTargetId: string }): Promise<OrcadDeltaMoveResult> => {
      const userDataPath = getUserDataPath()
      const { store, claims, target } = requireChangedHost(args)
      const environment = listEnvironments(userDataPath).find(
        (entry) => entry.id === target.orcadFence?.environmentId
      )
      if (!environment) {
        throw new Error('The managed Orca server for this host is no longer registered.')
      }
      const result = await runOrcadDeltaMove({
        userDataPath,
        store,
        claims,
        target,
        environment,
        destination: orcadMigrationDestinationFor(environment),
        censusHost: censusHostRelayTerminalsFor(target),
        ensureTunnel: async () => {
          await ensureOrcadManagedTunnel(userDataPath, environment.id)
        },
        runTargetLifecycle
      })
      if (result.outcome === 'moved') {
        publishResolvedChangedHostStatus(target, environment.id)
      }
      return result
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:keepOrcadServerVersion',
    async (_event, args: { sshTargetId: string }): Promise<void> => {
      const { store, claims, target, environmentId } = requireChangedHost(args)
      await runTargetLifecycle(target.id, () =>
        keepOrcadServerVersion({ userDataPath: getUserDataPath(), store, claims, target })
      )
      publishResolvedChangedHostStatus(target, environmentId)
    }
  )
}

function requireChangedHost(args: { sshTargetId: string } | undefined) {
  const sshTargetId = requiredString(args?.sshTargetId, 'SSH target')
  const { targetStore, claims } = requireManagedOrcadInfrastructure()
  const store = targetStore.getOrcadMigrationSource()
  const target = store.getSshTarget(sshTargetId)
  if (!target?.orcadFence?.sourceChangedAt) {
    throw new Error('This SSH host has no changes from an older Orca to resolve.')
  }
  return { store, claims, target, environmentId: target.orcadFence.environmentId }
}
