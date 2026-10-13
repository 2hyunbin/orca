import { fingerprintPluginReview } from '../../shared/plugins/plugin-consent-fingerprint'
import type { Store } from '../persistence'
import { applyPluginConsent } from './plugin-enablement'
import type {
  PluginMarketplaceInstallPreview,
  PluginMarketplaceInstaller
} from './plugin-marketplace-installer'
import type { PluginMarketplaceService } from './plugin-marketplace-service'
import type { PluginService } from './plugin-service'

export async function installMarketplaceDataPlugin(input: {
  store: Store
  pluginService: PluginService
  marketplace: PluginMarketplaceService
  installer: PluginMarketplaceInstaller
  marketplaceSourceId: string
  marketplaceCommit: string
  pluginKey: string
  originWebContentsId?: number
}): Promise<
  | { kind: 'installed'; pluginKey: string }
  | { kind: 'review'; preview: PluginMarketplaceInstallPreview }
  | { kind: 'error'; error: string }
> {
  const { pluginService, installer, pluginKey, store } = input
  await pluginService.whenReady()
  if (!pluginService.options.isPluginSystemEnabled()) {
    return { kind: 'error', error: 'enable the plugin system before installing a plugin' }
  }
  const listing = await input.marketplace.findPlugin(input.marketplaceSourceId, pluginKey)
  if (!listing || listing.marketplaceCommit !== input.marketplaceCommit) {
    return { kind: 'error', error: 'catalog changed; refresh before installing this release' }
  }
  const preview = await installer.preview(input.marketplaceSourceId, pluginKey)
  if (preview.marketplaceCommit !== input.marketplaceCommit) {
    return { kind: 'error', error: 'catalog changed; refresh before installing this release' }
  }
  const current = pluginService.findValidPlugin(pluginKey)
  const previous = current && !pluginService.isBundledDataPlugin(current) ? current : null
  const approved = store.getSettings().pluginConsents[pluginKey] === preview.consentFingerprint
  const data = preview.manifest.manifestVersion === 2 && preview.manifest.execution === 'data'
  if (
    !listing.release ||
    listing.release.execution !== 'data' ||
    !data ||
    (previous &&
      (previous.isDev ||
        previous.manifest.manifestVersion !== 2 ||
        previous.manifest.execution !== 'data' ||
        !approved))
  ) {
    return { kind: 'review', preview }
  }
  const result = await installer.install(preview, {
    consentFingerprint: preview.consentFingerprint,
    currentContentHash: previous?.contentHash ?? null
  })
  if (!result.ok) {
    return { kind: 'error', error: result.error }
  }
  await pluginService.refresh()
  const installed = pluginService.findValidPlugin(pluginKey)
  if (
    !installed ||
    installed.manifest.manifestVersion !== 2 ||
    installed.manifest.execution !== 'data' ||
    installed.contentHash !== result.contentHash ||
    installed.consentFingerprint !== preview.consentFingerprint
  ) {
    return { kind: 'error', error: 'installed plugin changed; refresh before enabling it' }
  }
  // Explicit data updates preserve a previous disabled choice.
  if (!previous) {
    await applyPluginConsent({
      store,
      pluginService,
      pluginKey,
      reviewedFingerprint: installed.consentFingerprint,
      reviewedRevision: fingerprintPluginReview(installed.consentFingerprint, result.contentHash),
      decision: 'approve',
      originWebContentsId: input.originWebContentsId
    })
  }
  return { kind: 'installed', pluginKey }
}
