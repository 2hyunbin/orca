import { defineMethod } from '../core'
import {
  pluginManagementRequestSchema,
  PLUGIN_MANAGEMENT_RUNTIME_CAPABILITY
} from '../../../../shared/plugins/plugin-management-api'
import type { PluginManagementController } from '../../../plugins/plugin-management-controller'

let controller: PluginManagementController | null = null
export function setPluginManagementControllerForRpc(next: PluginManagementController | null): void {
  controller = next
}
export function pluginManagementRpcAvailable(): boolean {
  return controller !== null
}

export const PLUGIN_MANAGEMENT_METHODS = [
  defineMethod({
    name: 'plugins.management.call',
    permission: 'host-admin',
    params: pluginManagementRequestSchema,
    handler: (request, context) => {
      if (
        context.clientKind !== 'runtime' ||
        !context.connectionId ||
        !context.clientId ||
        !context.signal ||
        !context.clientCapabilities?.includes(PLUGIN_MANAGEMENT_RUNTIME_CAPABILITY)
      ) {
        throw new Error('Plugin management requires a negotiated paired runtime connection')
      }
      if (request.runtimeId !== context.runtime.getRuntimeId()) {
        throw new Error('Plugin review belongs to another host or server instance')
      }
      if (!controller) {
        throw new Error('Plugin management is unavailable on this host')
      }
      return controller.call(request, context.signal)
    }
  })
]
