import { describe, expect, it } from 'vitest'
import type { PluginMarketplaceHostListing } from '../../../../preload/api-types'
import { pluginCatalogReleaseSchema } from '../../../../shared/plugins/plugin-catalog-release'
import { filterPluginCatalog, pluginCatalogListingIdentity } from './plugin-catalog-filter'

const locale: PluginMarketplaceHostListing = {
  marketplaceSourceId: 'source-a',
  marketplaceName: 'Catalog',
  marketplaceOwner: 'curator',
  marketplaceCommit: 'a'.repeat(40),
  pluginKey: 'author.locale-de',
  name: 'Deutsch',
  description: 'German interface language',
  source: { kind: 'git', url: 'https://example.com/author/de.git', ref: 'v1.0.0' },
  categories: [],
  official: false,
  bundled: false,
  release: pluginCatalogReleaseSchema.parse({
    version: '1.0.0',
    commit: 'b'.repeat(40),
    contentHash: 'c'.repeat(64),
    execution: 'data',
    minimumOrca: '1.0.0',
    types: ['interface-language'],
    license: 'MIT',
    preview: { title: 'Preview', text: 'Datei öffnen' }
  })
}
const appearance: PluginMarketplaceHostListing = {
  ...locale,
  pluginKey: 'author.theme',
  name: 'Theme',
  release: undefined,
  categories: ['themes']
}

describe('catalog filtering', () => {
  it('finds publisher, display name, description and preview text', () => {
    for (const query of ['AUTHOR', 'Deutsch', 'German', 'öffnen']) {
      expect(filterPluginCatalog([locale], query, 'all')).toEqual([locale])
    }
  })
  it('uses release types for data families and keeps legacy appearance listings discoverable', () => {
    expect(filterPluginCatalog([locale, appearance], '', 'interface-language')).toEqual([locale])
    expect(filterPluginCatalog([locale, appearance], '', 'appearance')).toEqual([appearance])
    expect(filterPluginCatalog([locale, appearance], '', 'file-viewer')).toEqual([])
    expect(filterPluginCatalog([locale, appearance], 'Deutsch', 'appearance')).toEqual([])
  })
  it('does not conflate the same package across independent catalog sources', () => {
    expect(pluginCatalogListingIdentity(locale)).not.toBe(
      pluginCatalogListingIdentity({ ...locale, marketplaceSourceId: 'source-b' })
    )
  })
  it('makes reviewed environment providers a first-class category', () => {
    const provider = {
      ...locale,
      pluginKey: 'company.platform',
      name: 'Development pods',
      release: pluginCatalogReleaseSchema.parse({
        ...locale.release,
        execution: 'instructional',
        types: ['environment-provider']
      })
    }
    expect(filterPluginCatalog([provider, locale], '', 'environment-provider')).toEqual([provider])
    expect(filterPluginCatalog([provider], 'development', 'environment-provider')).toEqual([
      provider
    ])
    expect(filterPluginCatalog([provider], '', 'other')).toEqual([])
  })
})
