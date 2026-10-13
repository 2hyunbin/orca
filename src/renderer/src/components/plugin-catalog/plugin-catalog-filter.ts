import type { PluginCatalogRelease } from '../../../../shared/plugins/plugin-catalog-release'

export type SearchablePluginCatalogListing = {
  pluginKey: string
  name?: string | null
  description?: string | null
  marketplaceName: string
  marketplaceOwner: string
  categories: readonly string[]
  release?: PluginCatalogRelease
}

export const PLUGIN_CATALOG_FILTERS = [
  'all',
  'interface-language',
  'coding-language',
  'file-viewer',
  'environment-provider',
  'appearance',
  'other'
] as const
export type PluginCatalogTypeFilter = (typeof PLUGIN_CATALOG_FILTERS)[number]

export function pluginCatalogListingIdentity(listing: {
  marketplaceSourceId: string
  pluginKey: string
}): string {
  return `${listing.marketplaceSourceId}:${listing.pluginKey}`
}

export function matchesPluginCatalogType(
  listing: SearchablePluginCatalogListing,
  filter: PluginCatalogTypeFilter
): boolean {
  if (filter === 'all') {
    return true
  }
  const types = listing.release?.types ?? []
  const appearance =
    types.some((type) => ['app-theme', 'icon-theme', 'terminal-theme'].includes(type)) ||
    listing.categories.some((category) =>
      ['themes', 'icon-themes', 'terminal-themes'].includes(category)
    )
  if (filter === 'appearance') {
    return appearance
  }
  if (filter === 'other') {
    return (
      !appearance &&
      !types.some((type) =>
        ['interface-language', 'coding-language', 'file-viewer', 'environment-provider'].includes(
          type
        )
      )
    )
  }
  return types.includes(filter)
}

export function filterPluginCatalog<T extends SearchablePluginCatalogListing>(
  listings: readonly T[],
  search: string,
  type: PluginCatalogTypeFilter
): T[] {
  const query = search.trim().toLocaleLowerCase()
  return listings.filter(
    (listing) =>
      matchesPluginCatalogType(listing, type) &&
      (!query ||
        [
          listing.name ?? '',
          listing.pluginKey,
          listing.description ?? '',
          listing.marketplaceName,
          listing.marketplaceOwner,
          ...listing.categories,
          ...(listing.release?.types ?? []),
          listing.release?.preview?.text ?? ''
        ].some((value) => value.toLocaleLowerCase().includes(query)))
  )
}
