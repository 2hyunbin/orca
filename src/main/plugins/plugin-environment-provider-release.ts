import type { PluginEnvironmentProviderReleaseReview } from '../../shared/plugins/plugin-environment-provider-api'
import type { PluginService } from './plugin-service'
import { environmentRecipeDigest } from './plugin-environment-recipe-execution'
import { verifyReviewedPluginRelease } from './plugin-reviewed-release'

export async function resolveReviewedPluginEnvironmentProvider(
  service: Pick<PluginService, 'whenReady' | 'contentPacks'>,
  review: PluginEnvironmentProviderReleaseReview
) {
  await service.whenReady()
  const authority = await service.contentPacks.environmentRecipes.resolveAuthority(
    review.providerId
  )
  if (!authority) {
    throw new Error('Environment provider is unavailable or requires approval')
  }
  const { plugin, registration } = authority
  if (
    plugin.manifest.manifestVersion !== 2 ||
    registration.recipe.protocolVersion !== 2 ||
    !plugin.consentSource ||
    plugin.consentFingerprint !== review.consentFingerprint ||
    plugin.reviewRevision !== review.reviewRevision ||
    environmentRecipeDigest(registration.recipe) !== review.recipeDigest
  ) {
    throw new Error('Environment provider release, commands or protocol changed since review')
  }
  await verifyReviewedPluginRelease(plugin, review.reviewRevision)
  if (!authority.isCurrent()) {
    throw new Error('Environment provider changed during admission')
  }
  return authority
}
