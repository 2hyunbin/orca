import { createHash } from 'node:crypto'
import { canonicalizeCapabilitySet } from './plugin-capabilities'
import type { PluginManifest } from './plugin-manifest'
import type { PluginInstallSource } from './plugin-install-lockfile'
import { canonicalizePluginConsentSource } from './plugin-consent-source'

type PluginConsentSubject = Pick<PluginManifest, 'capabilities' | 'main'> & {
  manifestVersion?: number
  execution?: string
  contributes?: Partial<
    Pick<PluginManifest['contributes'], 'panels' | 'keybindings' | 'vmRecipes' | 'agents'>
  > & { fileViewers?: readonly unknown[]; environmentRecipes?: readonly unknown[] }
}

export function hasInstructionalPluginContributions(manifest: PluginConsentSubject): boolean {
  const contributions = manifest.contributes
  return Boolean(
    contributions &&
    ((contributions.keybindings?.length ?? 0) > 0 ||
      (contributions.vmRecipes?.length ?? 0) > 0 ||
      (contributions.environmentRecipes?.length ?? 0) > 0 ||
      (contributions.agents?.length ?? 0) > 0)
  )
}

// Why: data approvals must not authorize later executable entries.
export function canonicalizePluginConsent(
  manifest: PluginConsentSubject,
  contentIdentity?: string,
  source?: PluginInstallSource
): string {
  const capabilities = canonicalizeCapabilitySet(manifest.capabilities)
  const panelIdentity = manifest.contributes?.panels?.length ? '\0sandboxed-plugin-ui' : ''
  const viewerIdentity = manifest.contributes?.fileViewers?.length
    ? '\0opened-document-viewer:readonly:host-ui'
    : ''
  const workerIdentity = manifest.main === undefined ? '' : '\0trusted-node-worker'
  // Instructional bytes execute later under user or agent authority, so
  // approval is bound to their immutable install/dev-tree identity.
  const instructionalIdentity = hasInstructionalPluginContributions(manifest)
    ? `\0instructional-content:${contentIdentity ?? 'unresolved'}`
    : ''
  const profileIdentity = manifest.manifestVersion === 2 ? `\0profile-v2:${manifest.execution}` : ''
  const sourceIdentity =
    manifest.manifestVersion === 2
      ? `\0source-v2:${source ? canonicalizePluginConsentSource(source) : 'unresolved'}`
      : ''
  return `${capabilities}${profileIdentity}${panelIdentity}${viewerIdentity}${workerIdentity}${instructionalIdentity}${sourceIdentity}`
}

export function fingerprintPluginConsent(
  manifest: PluginConsentSubject,
  contentIdentity?: string,
  source?: PluginInstallSource
): string {
  return `sha256-${createHash('sha256')
    .update(canonicalizePluginConsent(manifest, contentIdentity, source))
    .digest('base64')}`
}

export function fingerprintPluginReview(consentFingerprint: string, contentHash: string): string {
  return `review-sha256-${createHash('sha256')
    .update(JSON.stringify([consentFingerprint, contentHash]))
    .digest('base64')}`
}
