import { z } from 'zod'

export const pluginChangeEventSchema = z.strictObject({
  environmentProviderId: z.string().min(1).max(512).optional(),
  /** True only when declarative contribution catalogs were reconciled. */
  contentPacksChanged: z.boolean()
})
export type PluginChangeEvent = z.infer<typeof pluginChangeEventSchema>
