import { z } from 'zod'
import { PLUGIN_COMMIT_PATTERN } from './plugin-install-lockfile'
import {
  pluginExecutionAllowsContribution,
  pluginExecutionProfileSchema
} from './plugin-execution-profile'
import type { PluginManifest } from './plugin-manifest'

export const PLUGIN_CATALOG_TYPES = [
  'interface-language',
  'coding-language',
  'file-viewer',
  'environment-provider',
  'app-theme',
  'icon-theme',
  'terminal-theme',
  'panel',
  'instructions',
  'worker'
] as const

export const pluginCatalogReleaseSchema = z
  .strictObject({
    version: z.string().min(1).max(128),
    commit: z.string().regex(PLUGIN_COMMIT_PATTERN),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/, 'release requires a full SHA-256 digest'),
    execution: pluginExecutionProfileSchema,
    minimumOrca: z.string().regex(/^\d+\.\d+\.\d+$/),
    types: z
      .array(z.enum(PLUGIN_CATALOG_TYPES))
      .min(1)
      .max(PLUGIN_CATALOG_TYPES.length)
      .refine((types) => new Set(types).size === types.length, 'duplicate contribution type'),
    license: z.string().min(1).max(128),
    preview: z
      .strictObject({
        title: z.string().min(1).max(128),
        text: z.string().min(1).max(8192)
      })
      .optional()
  })
  .superRefine((release, context) => {
    for (const [index, type] of release.types.entries()) {
      const contribution =
        type === 'worker'
          ? 'worker'
          : type === 'panel' || type === 'file-viewer'
            ? 'ui'
            : type === 'instructions' || type === 'environment-provider'
              ? 'instructions'
              : null
      if (contribution && !pluginExecutionAllowsContribution(release.execution, contribution)) {
        context.addIssue({
          code: 'custom',
          path: ['types', index],
          message: `${release.execution} cannot declare ${type}`
        })
      }
    }
    if (release.execution === 'trusted-worker' && !release.types.includes('worker')) {
      context.addIssue({
        code: 'custom',
        path: ['types'],
        message: 'trusted-worker requires a worker'
      })
    }
  })

export type PluginCatalogRelease = z.infer<typeof pluginCatalogReleaseSchema>
export type PluginCatalogType = (typeof PLUGIN_CATALOG_TYPES)[number]

export function pluginCatalogTypes(manifest: PluginManifest): PluginCatalogType[] {
  const c = manifest.contributes
  const types: PluginCatalogType[] = []
  if (c.languagePacks.length) {
    types.push('interface-language')
  }
  if (manifest.manifestVersion === 2 && manifest.contributes.languages.length) {
    types.push('coding-language')
  }
  if (manifest.manifestVersion === 2 && manifest.contributes.fileViewers.length) {
    types.push('file-viewer')
  }
  if (manifest.manifestVersion === 2 && manifest.contributes.environmentRecipes.length) {
    types.push('environment-provider')
  }
  if (c.themes.length) {
    types.push('app-theme')
  }
  if (c.iconThemes.length) {
    types.push('icon-theme')
  }
  if (c.terminalThemes.length) {
    types.push('terminal-theme')
  }
  if (c.panels.length) {
    types.push('panel')
  }
  if (c.commands.length || c.keybindings.length || c.vmRecipes.length || c.agents.length) {
    types.push('instructions')
  }
  if (manifest.main) {
    types.push('worker')
  }
  return types
}

export function pluginCatalogReleaseError(input: {
  release: PluginCatalogRelease
  manifest: PluginManifest
  resolvedCommit: string | null
  contentHash: string
}): string | null {
  const { release, manifest } = input
  if (input.resolvedCommit !== release.commit) {
    return 'release tag no longer matches the catalog commit'
  }
  if (input.contentHash !== release.contentHash) {
    return 'plugin bytes do not match the catalog release hash'
  }
  if (manifest.manifestVersion !== 2) {
    return 'pinned catalog releases require a strict v2 manifest'
  }
  if (manifest.version !== release.version) {
    return 'manifest version does not match the catalog release'
  }
  if (manifest.execution !== release.execution) {
    return 'execution profile does not match the catalog release'
  }
  if (manifest.engines.orca !== `>=${release.minimumOrca}`) {
    return 'compatibility does not match the catalog release'
  }
  if (
    JSON.stringify(pluginCatalogTypes(manifest).sort()) !==
    JSON.stringify([...release.types].sort())
  ) {
    return 'contributions do not match the catalog release'
  }
  return null
}
