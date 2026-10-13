import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import { parsePluginVmRecipeArtifact } from '../../shared/plugins/plugin-vm-recipe-artifact'
import { PLUGIN_VM_RECIPE_MAX_BYTES } from './plugin-artifact-validation'
import {
  PluginRecipeArtifactRegistry,
  type PluginRecipeRegistration
} from './plugin-recipe-artifact-registry'

export type PluginVmRecipeRegistration = PluginRecipeRegistration<OrcaVmRecipe>

export class PluginVmRecipeRegistry extends PluginRecipeArtifactRegistry<OrcaVmRecipe> {
  constructor() {
    super({
      label: 'VM recipe',
      maxBytes: PLUGIN_VM_RECIPE_MAX_BYTES,
      contributions: (manifest) => manifest.contributes.vmRecipes,
      parse: parsePluginVmRecipeArtifact,
      identity: (_pluginKey, recipe) => recipe.id
    })
  }
}
