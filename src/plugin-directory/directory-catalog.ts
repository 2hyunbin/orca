import { z } from 'zod'
import type { PluginCatalogTypeFilter } from '../renderer/src/components/plugin-catalog/plugin-catalog-filter'
import {
  pluginCatalogSchema,
  pluginMarketplaceGitSourceSchema,
  isMarketplaceListingSupported
} from '../shared/plugins/plugin-marketplace'

export const DIRECTORY_CATALOG_BYTE_LIMIT = 16 * 1024 * 1024
export const DIRECTORY_CATALOG_FILENAME = 'directory-catalog.json'
export const directoryCatalogSchema = z.strictObject({
  formatVersion: z.literal(1),
  source: pluginMarketplaceGitSourceSchema,
  catalog: pluginCatalogSchema
})
export type DirectoryCatalog = z.infer<typeof directoryCatalogSchema>
export type DirectoryPlugin = DirectoryCatalog['catalog']['plugins'][number]

export class DirectoryCatalogError extends Error {
  constructor(readonly reason: 'invalid' | 'too-large' | 'unavailable' | 'timeout') {
    super(reason)
    this.name = 'DirectoryCatalogError'
  }
}

export function parseDirectoryCatalog(text: string): DirectoryCatalog {
  if (
    text.length > DIRECTORY_CATALOG_BYTE_LIMIT ||
    new TextEncoder().encode(text).byteLength > DIRECTORY_CATALOG_BYTE_LIMIT
  ) {
    throw new DirectoryCatalogError('too-large')
  }
  try {
    return directoryCatalogSchema.parse(JSON.parse(text))
  } catch {
    throw new DirectoryCatalogError('invalid')
  }
}

export function directoryListings(catalog: DirectoryCatalog['catalog']) {
  return catalog.plugins
    .filter((plugin) => isMarketplaceListingSupported(plugin.categories))
    .map((plugin) => ({
      ...plugin,
      pluginKey: plugin.id,
      marketplaceName: catalog.name,
      marketplaceOwner: catalog.owner
    }))
}

export function browsableRepository(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : null
  } catch {
    return null
  }
}

export const DIRECTORY_TYPE_LABELS = {
  all: 'All plugins',
  'interface-language': 'Interface languages',
  'coding-language': 'Coding languages',
  'file-viewer': 'File viewers',
  'environment-provider': 'Environment providers',
  appearance: 'Appearance',
  other: 'Other'
} as const satisfies Record<PluginCatalogTypeFilter, string>

export function directoryReviewCopy(execution: DirectoryPlugin['release']['execution']): string {
  switch (execution) {
    case 'data':
      return 'Declared data pack. Orca validates its contents. Adding executable features in an update requires a new review.'
    case 'sandboxed-ui':
      return 'Runs isolated plugin code. Orca asks you to review executable features and opened-file access before enabling them.'
    case 'instructional':
      return 'Adds instructions or actions. Review exactly what Orca will be allowed to launch or change before enabling them.'
    case 'trusted-worker':
      return 'Runs a full-trust worker with host capabilities. Review the source and requested access before enabling it.'
  }
}
