import { ManagedWorkspaceDiscoverySelectorSchema } from '../../../../shared/managed-workspace-discovery-contract'
import { defineMethod } from '../core'

export const MANAGED_WORKSPACE_DISCOVERY_METHODS = [
  defineMethod({
    name: 'managedServer.workspace.describe',
    permission: 'workspace',
    params: ManagedWorkspaceDiscoverySelectorSchema,
    handler: (selector, context) => {
      if (!context.managedWorkspace) {
        throw new Error('managed_workspace_discovery_unavailable')
      }
      return context.managedWorkspace.describe(selector, context.runtime.getRuntimeId())
    }
  })
] as const
