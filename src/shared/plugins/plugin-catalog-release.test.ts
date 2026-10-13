import { describe, expect, it } from 'vitest'
import { pluginCatalogReleaseError, pluginCatalogReleaseSchema } from './plugin-catalog-release'
import { parsePluginManifest } from './plugin-manifest'
import { pluginCatalogSchema, pluginMarketplaceSchema } from './plugin-marketplace'

const release = pluginCatalogReleaseSchema.parse({
  version: '1.0.0',
  commit: 'a'.repeat(40),
  contentHash: 'b'.repeat(64),
  execution: 'data',
  minimumOrca: '1.0.0',
  types: ['interface-language'],
  license: 'MIT'
})
const parsed = parsePluginManifest({
  manifestVersion: 2,
  execution: 'data',
  id: 'locale-de',
  publisher: 'community',
  name: 'German',
  version: '1.0.0',
  engines: { orca: '>=1.0.0' },
  pluginApi: 1,
  contributes: { languagePacks: [{ locale: 'de', path: 'de.json' }] }
})
if (!parsed.ok) {
  throw new Error(parsed.error)
}
const manifest = parsed.manifest
const catalog = {
  formatVersion: 2,
  name: 'Community',
  owner: 'community',
  plugins: [
    {
      id: 'community.locale-de',
      name: 'German',
      categories: ['languages'],
      source: { kind: 'git', url: 'https://example.com/community/locale-de.git', ref: 'v1.0.0' },
      release
    }
  ]
}

describe('pinned catalog release contract', () => {
  it('preserves v2 metadata through the shared catalog parser', () => {
    expect(pluginMarketplaceSchema.parse(catalog)).toEqual(catalog)
  })
  it('requires release checks on every v2 listing', () => {
    const { release: omitted, ...entry } = catalog.plugins[0]!
    expect(omitted).toBe(release)
    expect(pluginCatalogSchema.safeParse({ ...catalog, plugins: [entry] }).success).toBe(false)
  })
  it('rejects mixed versions, duplicate identities, self-awarded trust and unknown previews', () => {
    expect(pluginMarketplaceSchema.safeParse({ ...catalog, formatVersion: 3 }).success).toBe(false)
    expect(
      pluginMarketplaceSchema.safeParse({
        ...catalog,
        plugins: [...catalog.plugins, ...catalog.plugins]
      }).success
    ).toBe(false)
    expect(
      pluginMarketplaceSchema.safeParse({
        ...catalog,
        plugins: [{ ...catalog.plugins[0], official: true }]
      }).success
    ).toBe(false)
    expect(
      pluginCatalogReleaseSchema.safeParse({
        ...release,
        preview: { title: 'Demo', text: 'Hello', html: '<script>' }
      }).success
    ).toBe(false)
  })
  it('accepts only complete matching release facts', () => {
    expect(
      pluginCatalogReleaseError({
        release,
        manifest,
        resolvedCommit: release.commit,
        contentHash: release.contentHash
      })
    ).toBeNull()
  })
  it.each([
    ['commit', { commit: 'c'.repeat(40) }],
    ['contentHash', { contentHash: 'c'.repeat(64) }],
    ['version', { version: '2.0.0' }],
    ['execution', { execution: 'instructional' }],
    ['minimumOrca', { minimumOrca: '2.0.0' }],
    ['types', { types: ['coding-language'] }]
  ])('rejects a mismatched %s', (_field, change) => {
    const changed = pluginCatalogReleaseSchema.parse({ ...release, ...change })
    expect(
      pluginCatalogReleaseError({
        release: changed,
        manifest,
        resolvedCommit: release.commit,
        contentHash: release.contentHash
      })
    ).not.toBeNull()
  })
  it('rejects truncated hashes and duplicate types', () => {
    expect(
      pluginCatalogReleaseSchema.safeParse({ ...release, contentHash: 'b'.repeat(32) }).success
    ).toBe(false)
    expect(
      pluginCatalogReleaseSchema.safeParse({
        ...release,
        types: ['interface-language', 'interface-language']
      }).success
    ).toBe(false)
  })

  it.each([
    ['data', ['worker']],
    ['data', ['panel']],
    ['data', ['file-viewer']],
    ['data', ['instructions']],
    ['sandboxed-ui', ['instructions']],
    ['sandboxed-ui', ['worker']],
    ['instructional', ['file-viewer']],
    ['instructional', ['panel']],
    ['instructional', ['worker']],
    ['trusted-worker', ['interface-language']]
  ])('rejects a catalog claiming %s for %j before displaying it', (execution, types) => {
    expect(pluginCatalogReleaseSchema.safeParse({ ...release, execution, types }).success).toBe(
      false
    )
  })

  it.each([
    ['data', ['interface-language', 'coding-language', 'app-theme']],
    ['sandboxed-ui', ['file-viewer', 'panel', 'interface-language']],
    ['instructional', ['instructions', 'interface-language']],
    ['trusted-worker', ['worker', 'panel', 'instructions', 'file-viewer']]
  ])('keeps compatible %s packages discoverable: %j', (execution, types) => {
    expect(pluginCatalogReleaseSchema.safeParse({ ...release, execution, types }).success).toBe(
      true
    )
  })
})
