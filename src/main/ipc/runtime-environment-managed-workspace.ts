import { z } from 'zod'
import { registerPluginRendererHandler } from './plugin-renderer-ipc'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../shared/runtime-environments'
import {
  ManagedWorkspaceDiscoverySelectorSchema,
  MANAGED_WORKSPACE_DISCOVERY_CAPABILITY
} from '../../shared/managed-workspace-discovery-contract'
import { ManagedRuntimeGatewayDescriptorSchema } from '../../shared/managed-runtime-gateway-contract'
import { saveManagedGatewayEnvironment } from '../../shared/runtime-environment-gateway-store'
import { discoverManagedWorkspace } from '../runtime/managed-workspace-discovery'
import { currentRuntime } from './ssh-ipc-context'
import {
  callRuntimeEnvironment,
  getRuntimeEnvironmentStatus
} from './runtime-environment-transport-routing'
import { publicRuntimeEnvironmentWithHostKey } from './runtime-environment-host-key'
import { getRuntimeEnvironmentStatusOwner } from './runtime-environment-request-connections'
import { clearRuntimeEnvironmentManualDisconnect } from './runtime-environment-manual-disconnect'

const OpenManagedWorkspaceSchema = ManagedWorkspaceDiscoverySelectorSchema.extend({
  controllerEnvironmentId: z.string().min(1).max(256).optional()
})

export function registerManagedWorkspaceConnectionHandler(getUserDataPath: () => string): void {
  registerPluginRendererHandler(
    'runtimeEnvironments:openManagedWorkspace',
    async (_event, input: unknown) => {
      const args = OpenManagedWorkspaceSchema.parse(input)
      const userDataPath = getUserDataPath()
      let environment
      if (args.controllerEnvironmentId) {
        const before = await getRuntimeEnvironmentStatus(
          userDataPath,
          args.controllerEnvironmentId,
          15_000
        )
        if (
          !before.ok ||
          !before.result.capabilities?.includes(MANAGED_WORKSPACE_DISCOVERY_CAPABILITY)
        ) {
          throw new Error('Update the control host to open its managed workspaces')
        }
        const controller = resolveEnvironment(userDataPath, args.controllerEnvironmentId)
        if (controller.kind === 'managed-gateway') {
          throw new Error('Choose the machine’s control host to open this workspace')
        }
        const binding = JSON.stringify(getPreferredPairedRuntimeConnection(controller))
        const response = await callRuntimeEnvironment(
          userDataPath,
          controller.id,
          'managedServer.workspace.describe',
          {
            sshTargetId: args.sshTargetId,
            targetGeneration: args.targetGeneration
          },
          15_000,
          controller.pairingRevision ?? controller.createdAt
        )
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        const descriptor = ManagedRuntimeGatewayDescriptorSchema.parse(response.result)
        const latest = resolveEnvironment(userDataPath, controller.id)
        if (
          response._meta?.runtimeId !== descriptor.controllerRuntimeId ||
          (latest.pairingRevision ?? latest.createdAt) !==
            (controller.pairingRevision ?? controller.createdAt) ||
          JSON.stringify(getPreferredPairedRuntimeConnection(latest)) !== binding
        ) {
          throw new Error('The control host connection changed. Reconnect and try again.')
        }
        environment = saveManagedGatewayEnvironment(userDataPath, controller.id, descriptor)
      } else {
        if (!currentRuntime) {
          throw new Error('The local control host is unavailable')
        }
        const descriptor = await discoverManagedWorkspace(
          userDataPath,
          args,
          currentRuntime.getRuntimeId()
        )
        environment = resolveEnvironment(userDataPath, descriptor.environmentId)
      }
      clearRuntimeEnvironmentManualDisconnect(environment.id)
      const status = await getRuntimeEnvironmentStatus(userDataPath, environment.id, 15_000)
      if (!status.ok || status._meta?.runtimeId !== environment.runtimeId) {
        throw new Error(
          'The managed workspace is saved, but its server could not be reached. Reconnect and try again.'
        )
      }
      getRuntimeEnvironmentStatusOwner(userDataPath, environment.id).acceptVerified(status)
      return {
        environment: publicRuntimeEnvironmentWithHostKey(
          resolveEnvironment(userDataPath, environment.id)
        ),
        runtimeStatus: status.result
      }
    }
  )
}
