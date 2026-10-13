import { expect, it } from 'vitest'
import { fingerprintPluginConsent, fingerprintPluginReview } from './plugin-consent-fingerprint'
import { pluginManifestSchema } from './plugin-manifest'
import type { PluginInstallSource } from './plugin-install-lockfile'

const manifest = pluginManifestSchema.parse({
  manifestVersion: 2,
  execution: 'data',
  publisher: 'example',
  id: 'language',
  name: 'Language',
  version: '1.0.0',
  engines: { orca: '>=1.0.0' },
  pluginApi: 1,
  contributes: {}
})
const source: PluginInstallSource = {
  kind: 'marketplace',
  marketplace: {
    url: 'https://example.com/catalog.git',
    ref: 'main',
    resolvedCommit: 'a'.repeat(40),
    owner: 'example'
  },
  plugin: { url: 'https://example.com/language.git', ref: 'v1.0.0' }
}

it('requires review for repository, catalog, owner, channel and installation-kind changes', () => {
  const approved = fingerprintPluginConsent(manifest, 'a'.repeat(64), source)
  const changed: PluginInstallSource[] = [
    { ...source, plugin: { ...source.plugin, url: 'https://other.example/language.git' } },
    { ...source, marketplace: { ...source.marketplace, url: 'https://other.example/catalog.git' } },
    { ...source, marketplace: { ...source.marketplace, owner: 'another-owner' } },
    { ...source, marketplace: { ...source.marketplace, ref: 'beta' } },
    { kind: 'git', url: source.plugin.url, ref: source.plugin.ref },
    { kind: 'bundled', bundleId: 'example.language' },
    { kind: 'local-path', path: '/packages/language' }
  ]
  for (const candidate of changed) {
    expect(fingerprintPluginConsent(manifest, 'b'.repeat(64), candidate)).not.toBe(approved)
  }
  expect(fingerprintPluginConsent(manifest, undefined)).not.toBe(approved)
})

it('keeps data authority stable across pinned releases from the same owner', () => {
  const first = fingerprintPluginConsent(manifest, 'a'.repeat(64), source)
  const nextManifest = { ...manifest, version: '2.0.0' }
  const next = fingerprintPluginConsent(nextManifest, 'b'.repeat(64), {
    ...source,
    plugin: { ...source.plugin, ref: 'v2.0.0' },
    marketplace: { ...source.marketplace, resolvedCommit: 'b'.repeat(40) }
  })
  expect(next).toBe(first)
  expect(fingerprintPluginReview(first, 'a'.repeat(64))).not.toBe(
    fingerprintPluginReview(next, 'b'.repeat(64))
  )
})

it('keeps legacy approvals on the experimental path until v2 revalidation', () => {
  const legacy = { ...manifest, manifestVersion: 1, execution: undefined }
  expect(fingerprintPluginConsent(legacy, 'a'.repeat(64), source)).toBe(
    fingerprintPluginConsent(legacy)
  )
  expect(fingerprintPluginConsent(manifest, 'a'.repeat(64), source)).not.toBe(
    fingerprintPluginConsent(legacy)
  )
})
