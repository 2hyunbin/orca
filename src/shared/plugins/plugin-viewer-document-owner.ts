import { z } from 'zod'

export const pluginViewerDocumentOwnerSchema = z.strictObject({
  executionHostId: z.string().min(1).max(256),
  workspaceId: z.string().min(1).max(256),
  clientId: z.string().min(1).max(256),
  tabId: z.string().min(1).max(256),
  pluginKey: z.string().min(1).max(256),
  pluginGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
})

export type PluginViewerDocumentOwner = Readonly<z.infer<typeof pluginViewerDocumentOwnerSchema>>
