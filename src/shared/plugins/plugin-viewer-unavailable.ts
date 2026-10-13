import { z } from 'zod'

export const pluginViewerUnavailableSchema = z.strictObject({
  leaseId: z.uuid(),
  code: z.enum(['unavailable', 'unauthorized', 'limit_exceeded', 'unresponsive'])
})
export type PluginViewerUnavailable = z.infer<typeof pluginViewerUnavailableSchema>
