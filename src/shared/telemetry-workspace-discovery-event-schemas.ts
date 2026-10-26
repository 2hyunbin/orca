import { z } from 'zod'

const workspaceCount = z.number().int().min(0).max(50)
const workspaceDiscoveryContext = {
  surface: z.enum(['suggestion', 'manage']),
  workspace_count: workspaceCount
}

// Hidden sibling workspaces at project add, before either arm changes visibility.
export const workspaceDiscoveryEligibleSchema = z
  .object({ workspace_count: workspaceCount })
  .strict()
export const workspaceDiscoveryShownSchema = z.object(workspaceDiscoveryContext).strict()
export const workspaceDiscoveryActionSchema = z
  .object({
    ...workspaceDiscoveryContext,
    action: z.enum(['reviewed', 'import_completed', 'dismissed'])
  })
  .strict()
