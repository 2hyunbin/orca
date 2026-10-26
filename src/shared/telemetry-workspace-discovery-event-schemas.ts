import { z } from 'zod'

const workspaceDiscoveryContext = {
  surface: z.enum(['suggestion', 'manage']),
  workspace_count: z.number().int().min(0).max(50)
}

export const workspaceDiscoveryEligibleSchema = z.object({}).strict()
export const workspaceDiscoveryShownSchema = z.object(workspaceDiscoveryContext).strict()
export const workspaceDiscoveryActionSchema = z
  .object({
    ...workspaceDiscoveryContext,
    action: z.enum(['reviewed', 'import_completed', 'dismissed'])
  })
  .strict()
