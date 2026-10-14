import {
  environmentRecipeProviderId,
  parsePluginEnvironmentRecipe,
  PLUGIN_ENVIRONMENT_RECIPE_BYTES,
  PLUGIN_ENVIRONMENT_ADAPTER_BYTES,
  environmentRecipeAdapterPaths,
  type PluginEnvironmentRecipe
} from '../../shared/plugins/plugin-environment-recipe-artifact'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import {
  PluginRecipeArtifactRegistry,
  type PluginRecipeRegistration
} from './plugin-recipe-artifact-registry'

export type PluginEnvironmentRecipeRegistration = PluginRecipeRegistration<PluginEnvironmentRecipe>

export class PluginEnvironmentRecipeRegistry extends PluginRecipeArtifactRegistry<PluginEnvironmentRecipe> {
  constructor(canReadCurrentPlugin: (plugin: ValidDiscoveredPlugin) => boolean = () => true) {
    super({
      label: 'environment recipe',
      maxBytes: PLUGIN_ENVIRONMENT_RECIPE_BYTES,
      contributions: (manifest) =>
        manifest.manifestVersion === 2 ? manifest.contributes.environmentRecipes : [],
      parse: parsePluginEnvironmentRecipe,
      identity: environmentRecipeProviderId,
      preserveUnchangedAuthority: true,
      additionalArtifacts: (recipe) =>
        environmentRecipeAdapterPaths(recipe).map((path) => ({
          path,
          maxBytes: PLUGIN_ENVIRONMENT_ADAPTER_BYTES
        })),
      canReadCurrentPlugin
    })
  }
}
