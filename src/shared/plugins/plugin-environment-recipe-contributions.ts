import { z } from 'zod'
import { pluginRelativePathSchema } from './plugin-manifest-fields'

export const PLUGIN_ENVIRONMENT_RECIPE_LIMIT = 64
export const pluginEnvironmentRecipeContributionSchema = z.strictObject({
  path: pluginRelativePathSchema
})
export type PluginEnvironmentRecipeContribution = z.infer<
  typeof pluginEnvironmentRecipeContributionSchema
>
