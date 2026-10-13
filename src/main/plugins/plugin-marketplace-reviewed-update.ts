import { isReviewedEnvironmentRecipeOnlyUpdate } from './plugin-environment-recipe-update-review'
import {
  fingerprintPluginReview,
  hasInstructionalPluginContributions
} from '../../shared/plugins/plugin-consent-fingerprint'
import type { PluginReviewedMarketplaceUpdate } from '../../shared/plugins/plugin-reviewed-update'
import type { Store } from '../persistence'
import type { PluginInstallResult } from './plugin-install'
import type { PluginMarketplaceInstaller } from './plugin-marketplace-installer'
import type { PluginService } from './plugin-service'

export async function installReviewedMarketplaceUpdate(input: {
  request: PluginReviewedMarketplaceUpdate
  store: Store
  pluginService: PluginService
  installer: PluginMarketplaceInstaller
  originWebContentsId?: number
}): Promise<PluginInstallResult> {
  const { store, pluginService, installer } = input
  const request = { ...input.request }
  await pluginService.whenReady()
  if (!pluginService.options.isPluginSystemEnabled()) {
    return { ok: false, error: 'enable the plugin system before updating a plugin' }
  }
  const previous = pluginService.findValidPlugin(request.pluginKey)
  if (!previous || previous.isDev || previous.contentHash !== request.currentContentHash) {
    return { ok: false, error: 'installed plugin changed; refresh and review the update again' }
  }
  const previousConsent = store.getSettings().pluginConsents[request.pluginKey]
  const preview = await installer.preview(request.marketplaceSourceId, request.pluginKey)
  if (
    preview.manifest.manifestVersion !== 2 ||
    preview.marketplaceCommit !== request.marketplaceCommit ||
    preview.resolvedCommit !== request.resolvedCommit ||
    preview.contentHash !== request.contentHash ||
    preview.consentFingerprint !== request.reviewedFingerprint ||
    fingerprintPluginReview(preview.consentFingerprint, preview.contentHash) !==
      request.reviewedRevision
  ) {
    return { ok: false, error: 'plugin release changed; review the update again' }
  }
  if (
    (preview.manifest.execution === 'instructional' ||
      hasInstructionalPluginContributions(preview.manifest)) &&
    !isReviewedEnvironmentRecipeOnlyUpdate(preview, request.reviewedEnvironmentRecipeDigest)
  ) {
    return {
      ok: false,
      error: 'this update requires a full instruction review; the installed release is unchanged'
    }
  }
  let approvalAttempted = false
  const result = await installer.install(preview, undefined, {
    consentFingerprint: request.reviewedFingerprint,
    contentHash: request.contentHash,
    currentContentHash: request.currentContentHash,
    commitApproval: () => {
      const settings = store.getSettings()
      if (
        !pluginService.options.isPluginSystemEnabled() ||
        pluginService.options.getPluginKillListEntry?.(request.pluginKey) ||
        settings.pluginConsents[request.pluginKey] !== previousConsent
      ) {
        throw new Error('plugin approval changed; refresh and review the update again')
      }
      approvalAttempted = true
      store.updateSettings(
        {
          pluginConsents: {
            ...settings.pluginConsents,
            [request.pluginKey]: request.reviewedFingerprint
          }
        },
        { notifyListeners: true, originWebContentsId: input.originWebContentsId }
      )
    },
    restoreApproval: () => {
      if (!approvalAttempted) {
        return
      }
      const settings = store.getSettings()
      if (settings.pluginConsents[request.pluginKey] !== request.reviewedFingerprint) {
        return
      }
      const consents = { ...settings.pluginConsents }
      if (previousConsent === undefined) {
        delete consents[request.pluginKey]
      } else {
        consents[request.pluginKey] = previousConsent
      }
      store.updateSettings(
        { pluginConsents: consents },
        { notifyListeners: true, originWebContentsId: input.originWebContentsId }
      )
    }
  })
  // Reconcile after success or a recovered publication failure, never during staging.
  await pluginService.refresh()
  return result
}
