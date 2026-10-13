import { z } from 'zod'
import { environmentRecipeResourceSchema } from '../environment-recipe-protocol'
import { environmentRecipeJournalBindingSchema } from './plugin-environment-recipe-journal'

export const pluginEnvironmentSshBindingSchema = z.strictObject({
  version: z.literal(1),
  binding: environmentRecipeJournalBindingSchema.extend({
    contextId: environmentRecipeJournalBindingSchema.shape.contextId.unwrap()
  }),
  resourceId: environmentRecipeResourceSchema.shape.id,
  resourceRevision: environmentRecipeResourceSchema.shape.revision,
  connection: environmentRecipeResourceSchema.shape.connection.unwrap()
})
export type PluginEnvironmentSshBinding = z.infer<typeof pluginEnvironmentSshBindingSchema>

export function environmentProviderSshOwnerMatches(
  a: PluginEnvironmentSshBinding,
  b: PluginEnvironmentSshBinding
): boolean {
  return JSON.stringify(a.binding) === JSON.stringify(b.binding) && a.resourceId === b.resourceId
}
