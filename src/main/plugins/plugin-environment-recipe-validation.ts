import type { PluginManifest } from '../../shared/plugins/plugin-manifest'
import {
  parsePluginEnvironmentRecipe,
  PLUGIN_ENVIRONMENT_RECIPE_BYTES,
  PLUGIN_ENVIRONMENT_ADAPTER_BYTES,
  environmentRecipeAdapterPaths,
  type PluginEnvironmentRecipe
} from '../../shared/plugins/plugin-environment-recipe-artifact'
import { readContainedPluginArtifactText } from './plugin-artifact-file-reader'

export async function readPluginEnvironmentRecipeArtifacts(
  rootDir: string,
  manifest: PluginManifest
): Promise<PluginEnvironmentRecipe[]> {
  if (manifest.manifestVersion !== 2) {
    return []
  }
  const seen = new Set<string>()
  const recipes: PluginEnvironmentRecipe[] = []
  for (const contribution of manifest.contributes.environmentRecipes) {
    try {
      const recipe = parsePluginEnvironmentRecipe(
        await readContainedPluginArtifactText(
          rootDir,
          contribution.path,
          PLUGIN_ENVIRONMENT_RECIPE_BYTES
        )
      )
      if (seen.has(recipe.id)) {
        throw new Error(`duplicate environment recipe id "${recipe.id}"`)
      }
      seen.add(recipe.id)
      for (const entry of environmentRecipeAdapterPaths(recipe)) {
        await readContainedPluginArtifactText(rootDir, entry, PLUGIN_ENVIRONMENT_ADAPTER_BYTES)
      }
      recipes.push(recipe)
    } catch (error) {
      throw new Error(
        `environment recipe ${contribution.path}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return recipes
}

export async function validatePluginEnvironmentRecipeArtifacts(
  rootDir: string,
  manifest: PluginManifest
): Promise<string | null> {
  try {
    await readPluginEnvironmentRecipeArtifacts(rootDir, manifest)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
