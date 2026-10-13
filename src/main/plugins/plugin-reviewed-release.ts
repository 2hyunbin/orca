import { dirname } from 'node:path'
import { fingerprintPluginReview } from '../../shared/plugins/plugin-consent-fingerprint'
import { hashPluginTree } from './plugin-content-hash'
import { readPluginCurrentPointer } from './plugin-current-pointer'
import { discoverPluginConsent } from './plugin-discovery-consent'
import type { ValidDiscoveredPlugin } from './plugin-discovery'

export async function verifyReviewedPluginRelease(
  plugin: ValidDiscoveredPlugin,
  reviewedRevision: string | undefined
): Promise<void> {
  if (plugin.manifest.manifestVersion !== 2) {
    return
  }
  if (!reviewedRevision || reviewedRevision !== plugin.reviewRevision) {
    throw new Error(`plugin ${plugin.pluginKey} changed since its release was reviewed`)
  }
  const actual = await hashPluginTree(plugin.rootDir)
  if (
    !actual.ok ||
    fingerprintPluginReview(plugin.consentFingerprint, actual.hash) !== reviewedRevision
  ) {
    throw new Error(`plugin ${plugin.pluginKey} content changed since its release was reviewed`)
  }
  if (!plugin.isDev) {
    const current = await readPluginCurrentPointer(dirname(plugin.rootDir))
    if (current !== plugin.contentHash) {
      throw new Error(`plugin ${plugin.pluginKey} changed since its release was reviewed`)
    }
  }
  const consent = await discoverPluginConsent({
    rootDir: plugin.rootDir,
    pluginKey: plugin.pluginKey,
    manifest: plugin.manifest,
    isDev: plugin.isDev,
    installedContentHash: plugin.contentHash ?? undefined
  })
  if (
    consent.consentFingerprint !== plugin.consentFingerprint ||
    consent.reviewRevision !== reviewedRevision
  ) {
    throw new Error(`plugin ${plugin.pluginKey} source or release changed since it was reviewed`)
  }
}
