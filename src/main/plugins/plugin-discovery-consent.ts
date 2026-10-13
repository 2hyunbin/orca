import { realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  fingerprintPluginConsent,
  fingerprintPluginReview,
  hasInstructionalPluginContributions
} from '../../shared/plugins/plugin-consent-fingerprint'
import type {
  PluginInstallSource,
  PluginLockEntry
} from '../../shared/plugins/plugin-install-lockfile'
import type { PluginManifest } from '../../shared/plugins/plugin-manifest'
import { hashPluginTree } from './plugin-content-hash'
import { readPluginInstallProvenance } from './plugin-install-provenance'

export async function discoverPluginConsent(input: {
  rootDir: string
  pluginKey: string
  manifest: PluginManifest
  isDev: boolean
  installedContentHash?: string
  lockEntry?: PluginLockEntry
}): Promise<{
  consentFingerprint: string
  consentContentHash: string | null
  reviewRevision?: string
  reviewContentHash?: string
  consentSource?: PluginInstallSource
}> {
  let contentHash = input.installedContentHash
  let source: PluginInstallSource | undefined
  const strict = input.manifest.manifestVersion === 2
  if (input.isDev && (strict || hasInstructionalPluginContributions(input.manifest))) {
    const tree = await hashPluginTree(input.rootDir)
    if (!tree.ok) {
      throw new Error(tree.error)
    }
    contentHash = tree.hash
  }
  if (strict) {
    if (input.isDev) {
      source = { kind: 'local-path', path: await realpath(input.rootDir) }
    } else if (contentHash) {
      const provenance = await readPluginInstallProvenance(dirname(input.rootDir), contentHash)
      const entry = provenance ?? input.lockEntry
      if (entry?.pluginKey === input.pluginKey && entry.contentHash === contentHash) {
        source = entry.source
      }
    }
    if (!source || !contentHash) {
      throw new Error('v2 plugin has no verified install source')
    }
  }
  const consentContentHash = hasInstructionalPluginContributions(input.manifest)
    ? (contentHash ?? null)
    : null
  const consentFingerprint = fingerprintPluginConsent(
    input.manifest,
    consentContentHash ?? undefined,
    source
  )
  return {
    consentFingerprint,
    consentContentHash,
    ...(strict && contentHash
      ? {
          reviewRevision: fingerprintPluginReview(consentFingerprint, contentHash),
          reviewContentHash: contentHash,
          consentSource: source
        }
      : {})
  }
}
