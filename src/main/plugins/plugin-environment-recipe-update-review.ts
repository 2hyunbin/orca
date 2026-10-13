import { createHash } from 'node:crypto'
import type { PluginMarketplaceInstallPreview } from './plugin-marketplace-installer'
import type { PluginEnvironmentRecipePreview } from '../../shared/plugins/plugin-environment-recipe-preview'

export function environmentRecipeMarketplaceReviewDigest(
  recipes: PluginEnvironmentRecipePreview[]
): string {
  return createHash('sha256').update(JSON.stringify(recipes)).digest('hex')
}

export function isReviewedEnvironmentRecipeOnlyUpdate(
  preview: PluginMarketplaceInstallPreview,
  reviewedDigest: string | undefined
): boolean {
  const { manifest } = preview
  if (
    manifest.manifestVersion !== 2 ||
    manifest.execution !== 'instructional' ||
    !manifest.contributes.environmentRecipes.length ||
    manifest.main ||
    manifest.capabilities.length
  ) {
    return false
  }
  if (
    Object.entries(manifest.contributes).some(
      ([kind, entries]) => kind !== 'environmentRecipes' && entries.length
    )
  ) {
    return false
  }
  const recipes = preview.environmentRecipes
  return Boolean(
    recipes &&
    recipes.length === manifest.contributes.environmentRecipes.length &&
    reviewedDigest &&
    reviewedDigest === environmentRecipeMarketplaceReviewDigest(recipes)
  )
}
