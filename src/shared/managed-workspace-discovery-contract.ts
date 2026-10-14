import { z } from 'zod'

export const MANAGED_WORKSPACE_DISCOVERY_CAPABILITY =
  'managedServer.workspace-discovery.v1' as const
export const ManagedWorkspaceDiscoverySelectorSchema = z.strictObject({
  sshTargetId: z.string().min(1).max(256),
  targetGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
})
export type ManagedWorkspaceDiscoverySelector = z.infer<
  typeof ManagedWorkspaceDiscoverySelectorSchema
>
