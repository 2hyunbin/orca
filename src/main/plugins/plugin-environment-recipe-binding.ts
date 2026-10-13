import { createHash } from 'node:crypto'
import { canonicalizePluginConsentSource } from '../../shared/plugins/plugin-consent-source'
import {
  environmentRecipeProviderId,
  type PluginEnvironmentRecipe
} from '../../shared/plugins/plugin-environment-recipe-artifact'
import { environmentRecipeJournalBindingSchema } from '../../shared/plugins/plugin-environment-recipe-journal'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { environmentRecipeDigest } from './plugin-environment-recipe-execution'

export function buildPluginEnvironmentRecipeBinding(
  plugin: ValidDiscoveredPlugin,
  recipe: PluginEnvironmentRecipe,
  contextId: string,
  journalId?: string
) {
  if (!plugin.consentSource) {
    throw new Error('Environment provider has no verified source')
  }
  return environmentRecipeJournalBindingSchema.parse({
    executionHostId: 'local',
    providerId: environmentRecipeProviderId(plugin.pluginKey, recipe),
    contextId,
    ...(journalId ? { journalId } : {}),
    sourceDigest: createHash('sha256')
      .update(canonicalizePluginConsentSource(plugin.consentSource))
      .digest('hex'),
    recipeDigest: environmentRecipeDigest(recipe)
  })
}
