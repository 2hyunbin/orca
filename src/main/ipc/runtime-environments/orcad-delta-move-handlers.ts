/** IPC for a host an older build changed after conversion: move its newer projects, or keep the server's. */
import { ipcMain } from 'electron'
import type {
  OrcadDeltaMovePreview,
  OrcadDeltaMoveResult
} from '../../../shared/orcad-managed-runtime'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import { requireManagedOrcadInfrastructure } from '../../managed-server/lifecycle/orcad-managed-runtime-context'
import { ensureOrcadManagedTunnel } from '../../managed-server/lifecycle/orcad-managed-tunnel'
import { censusHostRelayTerminalsFor } from '../../ssh/legacy-relay/ssh-host-relay-census-for-target'
import {
  orcadMigrationDestinationFor,
  orcadServerAutomationEnablerFor
} from '../../managed-server/lifecycle/orcad-runtime-conversion-wiring'
import { enableMovedOrcadAutomationsForTarget } from '../../ssh/orcad-migration-moved-automations'
import { requiredString } from './orcad-runtime-lifecycle-handlers'
import { publishResolvedChangedHostStatus } from './runtime-environment-managed-tunnel'
import { ensureSshConnectionManager } from '../../ssh/targets/ssh-target-registry'
import { runTargetLifecycle } from '../ssh/ssh-target-lifecycle-queue'

export function registerOrcadDeltaMoveHandlers(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:previewOrcadDeltaMove',
    async (_event, args: { sshTargetId: string }): Promise<OrcadDeltaMovePreview> => {
      await ensureSshConnectionManager()
      const { planOrcadDeltaMove } = await import('../../ssh/orcad-migration-delta-plan')
      const { store, target } = requireChangedHost(args)
      const plan = planOrcadDeltaMove(getUserDataPath(), store, target)
      const { sshTargetId, environmentId, added, notReflected, blockers } = plan
      return { sshTargetId, environmentId, added, notReflected, blockers }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:moveOrcadDelta',
    async (_event, args: { sshTargetId: string }): Promise<OrcadDeltaMoveResult> => {
      await ensureSshConnectionManager()
      const { runOrcadDeltaMove } = await import('../../ssh/orcad-migration-delta-move')
      const { orcadMigrationDestinationFor } =
        await import('../../managed-server/lifecycle/orcad-runtime-conversion-wiring')
      const userDataPath = getUserDataPath()
      const { store, claims, target } = requireChangedHost(args)
      const environment = listEnvironments(userDataPath).find(
        (entry) => entry.id === target.orcadFence?.environmentId
      )
      if (!environment) {
        throw new Error('This host’s Orca server is no longer registered.')
      }
      const result = await runOrcadDeltaMove({
        userDataPath,
        store,
        claims,
        target,
        environment,
        connectDestination: async () =>
          orcadMigrationDestinationFor(
            await ensureOrcadManagedTunnel(userDataPath, environment.id)
          ),
        censusHost: censusHostRelayTerminalsFor(target),
        runTargetLifecycle
      })
      if (result.outcome === 'moved') {
        // Tunnel repair may have re-paired the server; read its current credentials.
        const paired = listEnvironments(userDataPath).find((entry) => entry.id === environment.id)
        const automationsLeftDisabled = await enableMovedOrcadAutomationsForTarget(
          userDataPath,
          target.id,
          orcadServerAutomationEnablerFor(paired ?? environment)
        ).catch((error: unknown) => {
          console.warn('[ssh] Could not re-enable moved automations:', error)
          return 0
        })
        publishResolvedChangedHostStatus(target, environment.id, automationsLeftDisabled)
      }
      return result
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:keepOrcadServerVersion',
    async (_event, args: { sshTargetId: string }): Promise<void> => {
      await ensureSshConnectionManager()
      const { keepOrcadServerVersion } = await import('../../ssh/orcad-migration-delta-move')
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
